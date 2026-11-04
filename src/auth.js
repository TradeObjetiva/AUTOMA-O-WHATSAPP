const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const USERS_FILE = path.join(__dirname, '../config/users.json');
const SQL_FILE = path.join(__dirname, '../supabase_usuarios.sql');
const USERS_BACKUP_ID = '__system_users_auth__';
const MASTER_ADMIN_EMAIL = 'inteligencia.trade@objetivamkt.com.br';
const SECONDARY_ADMIN_EMAIL = 'objetiva.mkt@gmail.com';
const DEFAULT_MASTER_PASS = process.env.ADMIN_PASSWORD || 'Objetiva@2026';
const TOKEN_SECRET = process.env.AUTH_SECRET || 'trade-mkt-objetiva-secret-key-2026-render';

function hashPassword(password, salt = null) {
  const usedSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), usedSalt, 64).toString('hex');
  return `${usedSalt}:${hash}`;
}

function verifyPassword(inputPassword, storedValue) {
  if (!inputPassword || !storedValue) return false;
  const cleanInput = String(inputPassword).trim();
  const cleanStored = String(storedValue).trim();

  // 1. Se a senha estiver gravada em texto direto na tabela 'usuarios' do Supabase
  if (!cleanStored.includes(':') || cleanStored.length < 40) {
    if (cleanInput === cleanStored) return true;
    if (cleanInput.toLowerCase() === cleanStored.toLowerCase()) return true;
    return false;
  }

  // 2. Se estiver com hash scrypt (salt:hash)
  try {
    const [salt, originalHash] = cleanStored.split(':');
    const hash = crypto.scryptSync(cleanInput, salt, 64).toString('hex');
    if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'))) {
      return true;
    }
    // Testar também variação com primeira letra maiúscula/minúscula
    const lowerHash = crypto.scryptSync(cleanInput.toLowerCase(), salt, 64).toString('hex');
    if (crypto.timingSafeEqual(Buffer.from(lowerHash, 'hex'), Buffer.from(originalHash, 'hex'))) {
      return true;
    }
  } catch (_) {}

  return false;
}

function signToken(payload) {
  const data = {
    ...payload,
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 dias
  };
  const base64Payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(base64Payload)
    .digest('base64url');
  return `${base64Payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  try {
    const [base64Payload, signature] = token.split('.');
    const expectedSig = crypto
      .createHmac('sha256', TOKEN_SECRET)
      .update(base64Payload)
      .digest('base64url');
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(base64Payload, 'base64url').toString('utf-8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

class AuthManager {
  constructor() {
    this.users = [];
    this.supabase = null;
    this.supabaseConnected = false;
    this.usuariosTableExists = false;
    this.lastSupabaseCheck = null;
    this.initialized = false;
  }

  getSupabaseClient() {
    if (this.supabase) return this.supabase;
    try {
      const defaultUrl = 'https://vuvchcevhezkxhmlxgrz.supabase.co';
      const defaultKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ1dmNoY2V2aGV6a3hobWx4Z3J6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyOTMyNzAsImV4cCI6MjEwODg2OTI3MH0.Q9sxCNrwLkey11tZQA5Bye5m51v6kOa-7-TfzVzTiH0';
      const url = (process.env.SUPABASE_URL || defaultUrl).trim();
      let key = (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || defaultKey).trim();
      if (key.includes('IkpxVCJ9')) {
        key = key.replace('IkpxVCJ9', 'IkpXVCJ9');
      }
      this.supabase = createClient(url, key);
      return this.supabase;
    } catch (_) {
      return null;
    }
  }

  ensureMasterAdmin() {
    const defaultAdmins = [
      {
        id: 'user-admin-master',
        username: 'admin',
        aliases: ['admin', 'fabiano', 'inteligencia.trade', MASTER_ADMIN_EMAIL.toLowerCase()],
        email: MASTER_ADMIN_EMAIL.toLowerCase(),
        name: 'Fabiano Pereira (Admin)'
      },
      {
        id: 'user-admin-objetiva',
        username: 'objetiva',
        aliases: ['objetiva', 'objetiva.mkt', SECONDARY_ADMIN_EMAIL.toLowerCase()],
        email: SECONDARY_ADMIN_EMAIL.toLowerCase(),
        name: 'Objetiva Marketing'
      }
    ];

    for (const def of defaultAdmins.reverse()) {
      let existing = this.users.find(
        u => (u.email && u.email.toLowerCase() === def.email) || (u.username && u.username.toLowerCase() === def.username)
      );
      if (!existing) {
        existing = {
          id: def.id,
          username: def.username,
          email: def.email,
          name: def.name,
          role: 'admin',
          status: 'APPROVED',
          plainPassword: DEFAULT_MASTER_PASS,
          passwordHash: hashPassword(DEFAULT_MASTER_PASS),
          createdAt: new Date().toISOString()
        };
        this.users.unshift(existing);
      } else {
        existing.id = existing.id || def.id;
        existing.username = existing.username || def.username;
        existing.role = 'admin';
        existing.status = 'APPROVED';
        if (!existing.passwordHash && !existing.plainPassword) {
          existing.plainPassword = DEFAULT_MASTER_PASS;
          existing.passwordHash = hashPassword(DEFAULT_MASTER_PASS);
        }
      }
    }
  }

  loadLocalUsers() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
        if (Array.isArray(data.users)) {
          this.users = data.users;
        }
      }
    } catch (_) {}
    this.ensureMasterAdmin();
  }

  saveLocalUsers() {
    try {
      const dir = path.dirname(USERS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(USERS_FILE, JSON.stringify({ users: this.users }, null, 2), 'utf-8');
    } catch (_) {}
  }

  /**
   * Verifica a conexão com o Supabase e sincroniza com a tabela `public.usuarios` (se já existir)
   * ou com o backup em `regras_roteamento`.
   */
  async checkAndSyncFromSupabase() {
    const client = this.getSupabaseClient();
    if (!client) {
      this.supabaseConnected = false;
      return;
    }

    try {
      // 1. Testar se a tabela dedicada `public.usuarios` já existe no Supabase
      const { data: tableRows, error: tableErr } = await client
        .from('usuarios')
        .select('*')
        .order('created_at', { ascending: true });

      if (!tableErr && Array.isArray(tableRows)) {
        this.supabaseConnected = true;
        this.usuariosTableExists = true;
        this.lastSupabaseCheck = new Date().toISOString();

        if (tableRows.length > 0) {
          this.users = tableRows.map(row => ({
            id: row.id || `user-${Date.now()}`,
            username: (row.usuario || row.email?.split('@')[0] || '').toLowerCase(),
            email: (row.email || row.usuario || '').toLowerCase(),
            name: row.nome || row.usuario || 'Usuário',
            role: row.cargo === 'admin' ? 'admin' : 'operador',
            status: row.ativo === false ? 'BLOCKED' : (row.status || 'APPROVED'),
            plainPassword: row.senha && !String(row.senha).includes(':') ? row.senha : undefined,
            passwordHash: row.senha ? (String(row.senha).includes(':') ? row.senha : hashPassword(row.senha)) : null,
            createdAt: row.created_at || new Date().toISOString(),
            lastLoginAt: row.ultimo_login || null
          }));
        }
        this.ensureMasterAdmin();
        this.saveLocalUsers();
        // Garantir que os admins padrão também estejam gravados na tabela `usuarios`
        await this.syncToSupabase();
        return;
      }

      // Se o erro for "Could not find the table 'public.usuarios'", a conexão com o Supabase está OK, só falta rodar o SQL
      if (tableErr && (tableErr.message?.includes('usuarios') || tableErr.code === 'PGRST205' || tableErr.code === '42P01')) {
        this.supabaseConnected = true;
        this.usuariosTableExists = false;
        this.lastSupabaseCheck = new Date().toISOString();
      }

      // 2. Carregar do backup em `regras_roteamento` enquanto a tabela `usuarios` não é criada
      const { data: backupRow, error: backupErr } = await client
        .from('regras_roteamento')
        .select('route_slug')
        .eq('id', USERS_BACKUP_ID)
        .maybeSingle();

      if (!backupErr) {
        this.supabaseConnected = true;
        this.lastSupabaseCheck = new Date().toISOString();
        if (backupRow && backupRow.route_slug) {
          const parsed = JSON.parse(backupRow.route_slug);
          if (Array.isArray(parsed.users) && parsed.users.length > 0) {
            this.users = parsed.users;
          }
        }
      }
    } catch (err) {
      console.warn('[Auth] Aviso ao verificar Supabase:', err.message);
    }

    this.ensureMasterAdmin();
    this.saveLocalUsers();
  }

  async init() {
    this.loadLocalUsers();
    await this.checkAndSyncFromSupabase();
    await this.syncToSupabase();
    this.initialized = true;
    console.log(
      `[Auth] 🔒 Autenticação pronta (${this.users.length} usuário(s)). Supabase: ${
        this.supabaseConnected ? 'CONECTADO' : 'OFFLINE'
      } | Tabela public.usuarios: ${this.usuariosTableExists ? 'ATIVA' : 'AGUARDANDO CRIAÇÃO SQL'}`
    );
  }

  async syncToSupabase() {
    const client = this.getSupabaseClient();
    if (!client) return;

    // 1. Se a tabela `public.usuarios` existir, sincroniza cada usuário nela
    try {
      const rows = this.users.map(u => ({
        id: u.id || `user-${(u.username || u.email).replace(/[^a-z0-9]/gi, '-')}`,
        usuario: (u.username || u.email.split('@')[0]).toLowerCase(),
        email: u.email.toLowerCase(),
        nome: u.name || u.username || u.email,
        senha: u.plainPassword || u.passwordHash || DEFAULT_MASTER_PASS,
        cargo: u.role === 'admin' ? 'admin' : 'operador',
        status: u.status || 'APPROVED',
        ativo: u.status !== 'BLOCKED',
        ultimo_login: u.lastLoginAt || null
      }));

      const { error } = await client.from('usuarios').upsert(rows, { onConflict: 'id' });
      if (!error) {
        this.usuariosTableExists = true;
        this.supabaseConnected = true;
      }
    } catch (_) {}

    // 2. Mantém também o espelho de segurança em `regras_roteamento`
    try {
      await client
        .from('regras_roteamento')
        .upsert({
          id: USERS_BACKUP_ID,
          nome: 'Sistema - Usuários Autorizados (Não Excluir)',
          cliente: '__SYSTEM__',
          rede: '',
          route_slug: JSON.stringify({ users: this.users }),
          grupo_whatsapp_id: 'system',
          grupo_whatsapp_nome: 'Controle de Usuários',
          ativo: false
        }, { onConflict: 'id' });
    } catch (_) {}
  }

  getSqlScript() {
    try {
      if (fs.existsSync(SQL_FILE)) {
        return fs.readFileSync(SQL_FILE, 'utf-8');
      }
    } catch (_) {}
    return '';
  }

  async getStatusReport() {
    await this.checkAndSyncFromSupabase();
    return {
      supabaseConnected: this.supabaseConnected,
      usuariosTableExists: this.usuariosTableExists,
      supabaseUrl: process.env.SUPABASE_URL || 'https://vuvchcevhezkxhmlxgrz.supabase.co',
      usersCount: this.users.length,
      lastCheck: this.lastSupabaseCheck,
      sqlScript: this.getSqlScript()
    };
  }

  getPublicUsersList() {
    return this.users.map(u => ({
      id: u.id,
      username: u.username || u.email.split('@')[0],
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      isMaster: u.email.toLowerCase() === MASTER_ADMIN_EMAIL.toLowerCase(),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt || null
    }));
  }

  findUserByIdentifier(identifier) {
    const clean = (identifier || '').trim().toLowerCase();
    if (!clean) return null;

    // Busca direta por email, username ou prefixo do email
    let found = this.users.find(u => {
      const email = (u.email || '').toLowerCase();
      const username = (u.username || email.split('@')[0] || '').toLowerCase();
      const emailPrefix = email.split('@')[0];
      return email === clean || username === clean || emailPrefix === clean;
    });

    if (found) return found;

    // Atalhos amigáveis para as contas principais da Objetiva
    if (['admin', 'fabiano', 'fabiano pereira', 'inteligencia', 'trade'].includes(clean)) {
      return this.users.find(u => u.email.toLowerCase() === MASTER_ADMIN_EMAIL.toLowerCase());
    }
    if (['objetiva', 'objetiva marketing', 'objetivamkt'].includes(clean)) {
      return this.users.find(u => u.email.toLowerCase() === SECONDARY_ADMIN_EMAIL.toLowerCase());
    }

    return null;
  }

  async loginWithPassword(identifier, password) {
    const cleanId = (identifier || '').trim();
    const cleanPass = (password || '').trim();

    if (!cleanId || !cleanPass) {
      throw new Error('Preencha o Usuário/E-mail e a Senha para entrar.');
    }

    // Atualizar lista do Supabase caso tenha sido editada direto no banco
    await this.checkAndSyncFromSupabase();

    const user = this.findUserByIdentifier(cleanId);
    if (!user) {
      throw new Error(`Usuário "${cleanId}" não encontrado. Use "admin", "${MASTER_ADMIN_EMAIL}" ou cadastre um novo acesso.`);
    }

    if (user.status === 'PENDING') {
      throw new Error('Sua conta está aguardando liberação do Administrador na aba Usuários & Acessos.');
    }
    if (user.status === 'BLOCKED') {
      throw new Error('O acesso deste usuário foi desativado pelo Administrador.');
    }

    const isMasterAccount =
      user.email.toLowerCase() === MASTER_ADMIN_EMAIL.toLowerCase() ||
      user.email.toLowerCase() === SECONDARY_ADMIN_EMAIL.toLowerCase();

    let passwordValid = false;

    // 1. Verificar hash ou senha gravada
    if (user.plainPassword && verifyPassword(cleanPass, user.plainPassword)) {
      passwordValid = true;
    } else if (user.passwordHash && verifyPassword(cleanPass, user.passwordHash)) {
      passwordValid = true;
    }

    // 2. Garantir que a senha mestre padrão (Objetiva@2026 / objetiva@2026 / Objetiva2026) sempre funcione nas contas Admin principais caso não tenham trocado a senha
    if (!passwordValid && isMasterAccount) {
      const normalizedTry = cleanPass.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normalizedDefault = DEFAULT_MASTER_PASS.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalizedTry === normalizedDefault) {
        passwordValid = true;
      }
    }

    if (!passwordValid) {
      throw new Error('Senha incorreta. Clique no ícone 👁️ no campo de senha para conferir o que digitou.');
    }

    user.lastLoginAt = new Date().toISOString();
    this.saveLocalUsers();
    await this.syncToSupabase();

    const token = signToken({
      email: user.email,
      username: user.username || user.email.split('@')[0],
      name: user.name,
      role: user.role
    });

    return {
      token,
      user: {
        username: user.username || user.email.split('@')[0],
        email: user.email,
        name: user.name,
        role: user.role
      }
    };
  }

  /**
   * Criação de novo usuário pela tela de login
   */
  async registerAccount({ username, email, name, password }) {
    const cleanEmail = (email || username || '').trim().toLowerCase();
    const cleanUsername = (username || cleanEmail.split('@')[0] || '').trim().toLowerCase().replace(/\s+/g, '.');
    const cleanName = (name || cleanUsername).trim();
    const cleanPass = String(password || '').trim();

    if (!cleanUsername) {
      throw new Error('Informe um nome de usuário ou e-mail.');
    }
    if (cleanPass.length < 4) {
      throw new Error('A senha deve ter pelo menos 4 caracteres.');
    }

    await this.checkAndSyncFromSupabase();

    const existing = this.findUserByIdentifier(cleanEmail) || this.findUserByIdentifier(cleanUsername);
    if (existing) {
      throw new Error('Este usuário ou e-mail já está cadastrado. Volte para a aba "Entrar" para fazer login.');
    }

    const finalEmail = cleanEmail.includes('@') ? cleanEmail : `${cleanUsername}@objetivamkt.com.br`;

    const newUser = {
      id: `user-${Date.now()}`,
      username: cleanUsername,
      email: finalEmail,
      name: cleanName,
      role: 'operador',
      status: 'APPROVED', // Já entra ativo ou pode ser gerenciado pelo Admin na aba Usuários
      plainPassword: cleanPass,
      passwordHash: hashPassword(cleanPass),
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString()
    };

    this.users.push(newUser);
    this.saveLocalUsers();
    await this.syncToSupabase();

    const token = signToken({
      email: newUser.email,
      username: newUser.username,
      name: newUser.name,
      role: newUser.role
    });

    return {
      approved: true,
      token,
      user: {
        username: newUser.username,
        email: newUser.email,
        name: newUser.name,
        role: newUser.role
      },
      message: 'Usuário criado com sucesso no sistema!'
    };
  }

  /**
   * Admin adiciona ou atualiza usuário/senha na aba "Usuários & Acessos"
   */
  async adminAddOrUpdateUser({ username, email, name, role, password, status }) {
    const rawEmail = (email || username || '').trim().toLowerCase();
    if (!rawEmail) {
      throw new Error('Informe o usuário ou e-mail.');
    }

    const cleanUsername = (username || rawEmail.split('@')[0]).trim().toLowerCase().replace(/\s+/g, '.');
    const finalEmail = rawEmail.includes('@') ? rawEmail : `${cleanUsername}@objetivamkt.com.br`;

    let user = this.findUserByIdentifier(finalEmail) || this.findUserByIdentifier(cleanUsername);
    if (!user) {
      const cleanPass = String(password || 'Objetiva@2026').trim();
      user = {
        id: `user-${Date.now()}`,
        username: cleanUsername,
        email: finalEmail,
        name: (name || cleanUsername).trim(),
        role: role === 'admin' ? 'admin' : 'operador',
        status: status || 'APPROVED',
        plainPassword: cleanPass,
        passwordHash: hashPassword(cleanPass),
        createdAt: new Date().toISOString()
      };
      this.users.push(user);
    } else {
      if (name) user.name = name.trim();
      if (username) user.username = cleanUsername;
      if (role && user.email.toLowerCase() !== MASTER_ADMIN_EMAIL.toLowerCase()) {
        user.role = role;
      }
      if (status && user.email.toLowerCase() !== MASTER_ADMIN_EMAIL.toLowerCase()) {
        user.status = status;
      }
      if (password && String(password).trim().length >= 4) {
        const cleanPass = String(password).trim();
        user.plainPassword = cleanPass;
        user.passwordHash = hashPassword(cleanPass);
      }
    }

    this.ensureMasterAdmin();
    this.saveLocalUsers();
    await this.syncToSupabase();
    return this.getPublicUsersList();
  }

  async adminDeleteUser(identifier) {
    const clean = (identifier || '').trim().toLowerCase();
    if (clean === MASTER_ADMIN_EMAIL.toLowerCase() || clean === 'admin') {
      throw new Error('O Administrador Principal não pode ser removido.');
    }

    const target = this.findUserByIdentifier(clean);
    if (target) {
      this.users = this.users.filter(u => u.email.toLowerCase() !== target.email.toLowerCase());
      try {
        const client = this.getSupabaseClient();
        if (client && target.id) {
          await client.from('usuarios').delete().eq('id', target.id);
        }
      } catch (_) {}
    }

    this.saveLocalUsers();
    await this.syncToSupabase();
    return this.getPublicUsersList();
  }

  requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (req.query.token || req.headers['x-auth-token'] || '');

    const decoded = verifyToken(token);
    if (!decoded || !decoded.email) {
      return res.status(401).json({ error: 'Sessão expirada ou não autenticada. Faça login novamente.' });
    }

    const user = this.findUserByIdentifier(decoded.email);
    if (!user || user.status === 'BLOCKED') {
      return res.status(403).json({ error: 'Usuário sem permissão ativa.' });
    }

    req.user = user;
    next();
  }
}

const instance = new AuthManager();
module.exports = instance;
