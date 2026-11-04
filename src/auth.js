const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const Storage = require('./storage');

const USERS_FILE = path.join(__dirname, '../config/users.json');
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

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, originalHash] = storedHash.split(':');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
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
    this.googleClientId = '';
    this.supabase = null;
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
        email: MASTER_ADMIN_EMAIL.toLowerCase(),
        name: 'Fabiano Pereira',
        avatarColor: '#7e22ce'
      },
      {
        email: SECONDARY_ADMIN_EMAIL.toLowerCase(),
        name: 'Objetiva Marketing',
        avatarColor: '#ea580c'
      }
    ];

    let changed = false;
    for (const def of defaultAdmins.reverse()) {
      let existing = this.users.find(u => u.email.toLowerCase() === def.email);
      if (!existing) {
        existing = {
          email: def.email,
          name: def.name,
          role: 'admin',
          status: 'APPROVED',
          passwordHash: hashPassword(DEFAULT_MASTER_PASS),
          picture: null,
          avatarColor: def.avatarColor,
          createdAt: new Date().toISOString()
        };
        this.users.unshift(existing);
        changed = true;
      } else {
        existing.role = 'admin';
        existing.status = 'APPROVED';
        if (existing.name === 'Inteligência Trade (Admin)') {
          existing.name = def.name;
        }
        if (!existing.avatarColor) {
          existing.avatarColor = def.avatarColor;
        }
        if (!existing.passwordHash) {
          existing.passwordHash = hashPassword(DEFAULT_MASTER_PASS);
        }
      }
    }
    return changed;
  }

  loadLocalUsers() {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
        if (Array.isArray(data.users)) {
          this.users = data.users;
        }
        if (data.googleClientId) {
          this.googleClientId = data.googleClientId;
        }
      }
    } catch (_) {}
    this.ensureMasterAdmin();
  }

  saveLocalUsers() {
    try {
      const dir = path.dirname(USERS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(USERS_FILE, JSON.stringify({
        users: this.users,
        googleClientId: this.googleClientId || ''
      }, null, 2), 'utf-8');
    } catch (_) {}
  }

  async init() {
    this.loadLocalUsers();
    try {
      const client = this.getSupabaseClient();
      if (client) {
        const { data } = await client
          .from('regras_roteamento')
          .select('route_slug')
          .eq('id', USERS_BACKUP_ID)
          .maybeSingle();

        if (data && data.route_slug) {
          const parsed = JSON.parse(data.route_slug);
          if (Array.isArray(parsed.users) && parsed.users.length > 0) {
            this.users = parsed.users;
          }
          if (parsed.googleClientId) {
            this.googleClientId = parsed.googleClientId;
          }
        }
      }
    } catch (err) {
      console.warn('[Auth] Aviso ao sincronizar usuários do Supabase:', err.message);
    }

    this.ensureMasterAdmin();
    this.saveLocalUsers();
    await this.syncToSupabase();
    this.initialized = true;
    console.log(`[Auth] 🔒 Sistema de autenticação ativo (${this.users.length} usuário(s) cadastrado(s)). Admin Principal: ${MASTER_ADMIN_EMAIL}`);
  }

  async syncToSupabase() {
    try {
      const client = this.getSupabaseClient();
      if (!client) return;
      await client
        .from('regras_roteamento')
        .upsert({
          id: USERS_BACKUP_ID,
          nome: 'Sistema - Usuários Autorizados (Não Excluir)',
          cliente: '__SYSTEM__',
          rede: '',
          route_slug: JSON.stringify({
            users: this.users,
            googleClientId: this.getGoogleClientId()
          }),
          grupo_whatsapp_id: 'system',
          grupo_whatsapp_nome: 'Controle de Usuários Google',
          ativo: false
        }, { onConflict: 'id' });
    } catch (err) {
      console.warn('[Auth] Aviso ao salvar usuários no Supabase:', err.message);
    }
  }

  getPublicAccountsChooserList() {
    return this.users
      .filter(u => u.status === 'APPROVED')
      .map(u => ({
        email: u.email,
        name: u.name || u.email.split('@')[0],
        picture: u.picture || null,
        avatarColor: u.avatarColor || '#2563eb'
      }));
  }

  getPublicUsersList() {
    return this.users.map(u => ({
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      picture: u.picture || null,
      hasPassword: Boolean(u.passwordHash),
      isMaster: u.email.toLowerCase() === MASTER_ADMIN_EMAIL.toLowerCase(),
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt || null
    }));
  }

  async loginWithPassword(email, password) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !password) {
      throw new Error('Informe seu e-mail Google e sua senha.');
    }

    const user = this.users.find(u => u.email.toLowerCase() === cleanEmail);
    if (!user) {
      throw new Error('Conta não encontrada. Use a aba "Criar Conta Google" ou solicite liberação ao administrador.');
    }

    if (user.status === 'PENDING') {
      throw new Error('Sua conta ainda está aguardando aprovação do administrador (inteligencia.trade@objetivamkt.com.br).');
    }
    if (user.status === 'BLOCKED') {
      throw new Error('O acesso desta conta foi bloqueado pelo administrador.');
    }

    if (!user.passwordHash) {
      throw new Error('Esta conta ainda não possui senha definida. Vá na aba "Criar Conta / Definir Senha" para criar sua senha.');
    }

    if (!verifyPassword(password, user.passwordHash)) {
      throw new Error('E-mail ou senha incorretos.');
    }

    user.lastLoginAt = new Date().toISOString();
    this.saveLocalUsers();
    await this.syncToSupabase();

    const token = signToken({
      email: user.email,
      name: user.name,
      role: user.role
    });

    return {
      token,
      user: {
        email: user.email,
        name: user.name,
        role: user.role,
        picture: user.picture
      }
    };
  }

  /**
   * Criação de conta vinculada ao e-mail Google (ou definição de senha de e-mail pré-autorizado pelo Admin)
   */
  async registerGoogleAccount({ email, name, password }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanName = (name || '').trim();

    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('Informe um e-mail Google ou corporativo válido.');
    }
    if (!password || String(password).length < 6) {
      throw new Error('A senha deve ter pelo menos 6 caracteres.');
    }

    const existing = this.users.find(u => u.email.toLowerCase() === cleanEmail);

    if (existing) {
      // Se o admin pré-cadastrou o e-mail (sem senha), o usuário define a senha agora e já entra!
      if (!existing.passwordHash) {
        existing.name = cleanName || existing.name;
        existing.passwordHash = hashPassword(password);
        existing.lastLoginAt = new Date().toISOString();
        this.saveLocalUsers();
        await this.syncToSupabase();

        if (existing.status === 'APPROVED') {
          const token = signToken({
            email: existing.email,
            name: existing.name,
            role: existing.role
          });
          return {
            approved: true,
            token,
            user: { email: existing.email, name: existing.name, role: existing.role },
            message: 'Senha definida com sucesso! Bem-vindo(a).'
          };
        }
      }
      throw new Error('Este e-mail já está cadastrado. Use a aba "Entrar" para fazer login.');
    }

    // Novo cadastro: solicita aprovação do Administrador
    const newUser = {
      email: cleanEmail,
      name: cleanName || cleanEmail.split('@')[0],
      role: 'operador',
      status: 'PENDING', // Aguarda aprovação do Admin para segurança total
      passwordHash: hashPassword(password),
      picture: null,
      createdAt: new Date().toISOString()
    };

    this.users.push(newUser);
    this.saveLocalUsers();
    await this.syncToSupabase();

    return {
      approved: false,
      message: 'Cadastro recebido! Por segurança, sua conta aguarda aprovação do administrador (inteligencia.trade@objetivamkt.com.br) na aba Usuários.'
    };
  }

  /**
   * Login 1-Clique com Token OAuth Oficial do Google (id_token ou access_token do popup)
   */
  async loginWithGoogleCredential(credential, accessToken = null) {
    let payload = null;

    if (accessToken) {
      const res = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      payload = res.data;
    } else if (credential) {
      const res = await axios.get(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
      payload = res.data;
    } else {
      throw new Error('Token do Google ausente.');
    }

    const isVerified = payload && (payload.email_verified === true || payload.email_verified === 'true');
    if (!payload || !payload.email || !isVerified) {
      throw new Error('Não foi possível validar o e-mail da conta Google.');
    }

    const cleanEmail = payload.email.toLowerCase();
    const name = payload.name || cleanEmail.split('@')[0];
    const picture = payload.picture || null;

    let user = this.users.find(u => u.email.toLowerCase() === cleanEmail);

    if (!user) {
      const isMaster = cleanEmail === MASTER_ADMIN_EMAIL.toLowerCase() || cleanEmail === SECONDARY_ADMIN_EMAIL.toLowerCase();
      user = {
        email: cleanEmail,
        name,
        role: isMaster ? 'admin' : 'operador',
        status: isMaster ? 'APPROVED' : 'PENDING',
        passwordHash: null,
        picture,
        createdAt: new Date().toISOString()
      };
      this.users.push(user);
      this.saveLocalUsers();
      await this.syncToSupabase();
    } else {
      if (name && !user.name) user.name = name;
      if (picture) user.picture = picture;
    }

    if (user.status === 'PENDING') {
      throw new Error(`A conta Google (${cleanEmail}) foi registrada e aguarda aprovação do administrador.`);
    }
    if (user.status === 'BLOCKED') {
      throw new Error(`O acesso da conta (${cleanEmail}) está bloqueado.`);
    }

    user.lastLoginAt = new Date().toISOString();
    this.saveLocalUsers();
    await this.syncToSupabase();

    const token = signToken({
      email: user.email,
      name: user.name,
      role: user.role
    });

    return {
      token,
      user: {
        email: user.email,
        name: user.name,
        role: user.role,
        picture: user.picture
      }
    };
  }

  /**
   * Admin adiciona/pré-autoriza um e-mail Google da equipe
   */
  async adminAddOrUpdateUser({ email, name, role, password, status }) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes('@')) {
      throw new Error('Informe um endereço de e-mail válido.');
    }

    let user = this.users.find(u => u.email.toLowerCase() === cleanEmail);
    if (!user) {
      user = {
        email: cleanEmail,
        name: (name || cleanEmail.split('@')[0]).trim(),
        role: role === 'admin' ? 'admin' : 'operador',
        status: status || 'APPROVED',
        passwordHash: password ? hashPassword(password) : null,
        picture: null,
        createdAt: new Date().toISOString()
      };
      this.users.push(user);
    } else {
      if (name) user.name = name.trim();
      if (role && user.email.toLowerCase() !== MASTER_ADMIN_EMAIL.toLowerCase()) {
        user.role = role;
      }
      if (status && user.email.toLowerCase() !== MASTER_ADMIN_EMAIL.toLowerCase()) {
        user.status = status;
      }
      if (password && String(password).trim().length >= 6) {
        user.passwordHash = hashPassword(String(password).trim());
      }
    }

    this.ensureMasterAdmin();
    this.saveLocalUsers();
    await this.syncToSupabase();
    return this.getPublicUsersList();
  }

  async adminDeleteUser(email) {
    const cleanEmail = (email || '').trim().toLowerCase();
    if (cleanEmail === MASTER_ADMIN_EMAIL.toLowerCase()) {
      throw new Error('O Administrador Principal não pode ser removido.');
    }
    this.users = this.users.filter(u => u.email.toLowerCase() !== cleanEmail);
    this.saveLocalUsers();
    await this.syncToSupabase();
    return this.getPublicUsersList();
  }

  async setGoogleClientId(clientId) {
    this.googleClientId = (clientId || '').trim();
    const currentSettings = Storage.getSettings();
    Storage.updateSettings({
      ...currentSettings,
      auth: { ...(currentSettings.auth || {}), googleClientId: this.googleClientId }
    });
    this.saveLocalUsers();
    await this.syncToSupabase();
    return this.getGoogleClientId();
  }

  getGoogleClientId() {
    const settings = Storage.getSettings();
    return (process.env.GOOGLE_CLIENT_ID || this.googleClientId || settings.auth?.googleClientId || '').trim();
  }

  /**
   * Middleware Express para proteger rotas da API do painel
   */
  requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : (req.query.token || req.headers['x-auth-token'] || '');

    const decoded = verifyToken(token);
    if (!decoded || !decoded.email) {
      return res.status(401).json({ error: 'Sessão expirada ou não autenticada. Faça login novamente.' });
    }

    const user = this.users.find(u => u.email.toLowerCase() === decoded.email.toLowerCase());
    if (!user || user.status !== 'APPROVED') {
      return res.status(403).json({ error: 'Usuário sem permissão ativa.' });
    }

    req.user = user;
    next();
  }
}

const instance = new AuthManager();
module.exports = instance;

