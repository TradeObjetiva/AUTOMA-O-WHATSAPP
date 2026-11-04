const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

// Polyfill de WebSocket para Node < 22
if (typeof globalThis.WebSocket === 'undefined') {
  try {
    globalThis.WebSocket = require('ws');
  } catch (_) {}
}

const AUTH_FOLDER = path.join(__dirname, '../auth_info_baileys');
const SESSION_BACKUP_ID = '__wa_session_backup__';

class WhatsAppManager {
  constructor() {
    this.sock = null;
    this.status = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, QR_READY, CONNECTED
    this.qrCodeRaw = null;
    this.qrCodeDataUrl = null;
    this.userProfile = null;
    this.connectedSince = null;
    this.groupsCache = [];
    this.lastGroupsFetch = 0;
    this.logger = pino({ level: 'silent' });
    this.isInitializing = false;
    this.isShuttingDown = false;
    this.reconnectTimeout = null;
    this.backupTimeout = null;
    this.supabase = null;
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
    } catch (err) {
      console.warn('[WhatsApp Cloud Auth] Aviso ao criar cliente Supabase:', err.message);
      return null;
    }
  }

  /**
   * Restaura os arquivos da sessão do WhatsApp a partir do Supabase Cloud.
   * Se forceOverwrite = true, sobrescreve os arquivos locais com a versão mais recente da nuvem.
   */
  async restoreSessionFromSupabase(forceOverwrite = false) {
    try {
      const credsPath = path.join(AUTH_FOLDER, 'creds.json');
      if (!forceOverwrite && fs.existsSync(credsPath)) {
        return true;
      }

      const client = this.getSupabaseClient();
      if (!client) return false;

      const { data, error } = await client
        .from('regras_roteamento')
        .select('route_slug')
        .eq('id', SESSION_BACKUP_ID)
        .maybeSingle();

      if (error || !data || !data.route_slug) {
        return false;
      }

      const filesMap = JSON.parse(data.route_slug);
      if (!filesMap || typeof filesMap !== 'object' || !filesMap['creds.json']) {
        return false;
      }

      if (!fs.existsSync(AUTH_FOLDER)) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
      }

      let restoredCount = 0;
      for (const [fileName, content] of Object.entries(filesMap)) {
        if (!fileName.endsWith('.json') || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
          continue;
        }
        fs.writeFileSync(path.join(AUTH_FOLDER, fileName), content, 'utf-8');
        restoredCount++;
      }

      console.log(`[WhatsApp Cloud Auth] ☁️ Sessão do WhatsApp restaurada do Supabase (${restoredCount} arquivos).`);
      return restoredCount > 0;
    } catch (err) {
      console.warn('[WhatsApp Cloud Auth] Aviso ao restaurar sessão do Supabase:', err.message);
      return false;
    }
  }

  /**
   * Salva os arquivos da pasta auth_info_baileys no Supabase Cloud (com debounce)
   */
  scheduleSessionBackup(delayMs = 2500) {
    if (this.isShuttingDown) return;
    if (this.backupTimeout) {
      clearTimeout(this.backupTimeout);
    }
    this.backupTimeout = setTimeout(() => {
      this.backupTimeout = null;
      if (!this.isShuttingDown && this.status === 'CONNECTED') {
        this.backupSessionToSupabase();
      }
    }, delayMs);
  }

  async backupSessionToSupabase() {
    if (this.isShuttingDown) return false;
    try {
      const credsPath = path.join(AUTH_FOLDER, 'creds.json');
      if (!fs.existsSync(credsPath)) return false;

      const client = this.getSupabaseClient();
      if (!client) return false;

      const allFiles = fs.readdirSync(AUTH_FOLDER).filter(f => f.endsWith('.json'));
      if (!allFiles.includes('creds.json')) return false;

      const essentialFiles = [];
      const preKeyFiles = [];

      for (const f of allFiles) {
        if (f.startsWith('pre-key-') || f.startsWith('sender-key-')) {
          preKeyFiles.push(f);
        } else {
          essentialFiles.push(f);
        }
      }

      const selectedPreKeys = preKeyFiles.slice(-120);
      const filesToBackup = [...essentialFiles, ...selectedPreKeys];

      const filesMap = {};
      for (const f of filesToBackup) {
        try {
          filesMap[f] = fs.readFileSync(path.join(AUTH_FOLDER, f), 'utf-8');
        } catch (_) {}
      }

      const { error } = await client
        .from('regras_roteamento')
        .upsert({
          id: SESSION_BACKUP_ID,
          nome: 'Sistema - Sessão WhatsApp Cloud',
          cliente: '__SYSTEM__',
          rede: '',
          route_slug: JSON.stringify(filesMap),
          grupo_whatsapp_id: 'system',
          grupo_whatsapp_nome: 'Backup Automático de Sessão WhatsApp',
          ativo: false
        }, { onConflict: 'id' });

      if (error) {
        console.warn('[WhatsApp Cloud Auth] Erro ao salvar backup da sessão no Supabase:', error.message);
        return false;
      }

      return true;
    } catch (err) {
      console.warn('[WhatsApp Cloud Auth] Exceção ao salvar sessão no Supabase:', err.message);
      return false;
    }
  }

  async clearSessionBackupInSupabase() {
    try {
      if (this.backupTimeout) {
        clearTimeout(this.backupTimeout);
        this.backupTimeout = null;
      }
      const client = this.getSupabaseClient();
      if (!client) return;
      await client
        .from('regras_roteamento')
        .delete()
        .eq('id', SESSION_BACKUP_ID);
      console.log('[WhatsApp Cloud Auth] 🗑️ Backup de sessão removido do Supabase Cloud.');
    } catch (err) {
      console.warn('[WhatsApp Cloud Auth] Aviso ao limpar backup de sessão:', err.message);
    }
  }

  cancelScheduledReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  scheduleReconnect(delayMs = 5000, forceCloudPull = false) {
    if (this.isShuttingDown) return;
    this.cancelScheduledReconnect();
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      if (this.isShuttingDown) return;
      if (forceCloudPull) {
        await this.restoreSessionFromSupabase(true);
      }
      this.init();
    }, delayMs);
  }

  async cleanupSocket() {
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }
  }

  /**
   * Chamado quando o Render envia SIGTERM/SIGINT para substituir o container em um deploy.
   * Fecha o socket imediatamente SEM fazer logout e SEM apagar o backup na nuvem.
   */
  async gracefulShutdown() {
    console.log('[WhatsApp] 🛑 Encerrando instância atual graciosamente (Deploy/Restart)...');
    this.isShuttingDown = true;
    this.cancelScheduledReconnect();
    if (this.backupTimeout) {
      clearTimeout(this.backupTimeout);
      this.backupTimeout = null;
    }
    await this.cleanupSocket();
  }

  async init() {
    if (this.isInitializing || this.isShuttingDown) {
      return false;
    }

    this.isInitializing = true;
    this.cancelScheduledReconnect();

    await this.cleanupSocket();

    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    await this.restoreSessionFromSupabase(false);

    try {
      this.status = 'CONNECTING';
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

      let version = [2, 3000, 1017531287];
      let isLatest = true;
      try {
        const vInfo = await fetchLatestBaileysVersion();
        version = vInfo.version;
        isLatest = vInfo.isLatest;
      } catch (verErr) {
        console.warn('[WhatsApp] Aviso ao verificar versão Baileys, usando fallback:', verErr.message);
      }

      console.log(`[WhatsApp] Inicializando Baileys v${version.join('.')} (Última: ${isLatest})`);

      this.sock = makeWASocket({
        version,
        logger: this.logger,
        printQRInTerminal: false,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger)
        },
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 300,
        browser: ['Trade Marketing Hub', 'Chrome', '122.0.0']
      });

      this.sock.ev.on('creds.update', async () => {
        if (this.isShuttingDown) return;
        await saveCreds();
        this.scheduleSessionBackup(2500);
      });

      this.sock.ev.on('connection.update', async (update) => {
        if (this.isShuttingDown) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCodeRaw = qr;
          this.status = 'QR_READY';
          this.connectedSince = null;
          try {
            this.qrCodeDataUrl = await QRCode.toDataURL(qr);
          } catch (e) {
            console.error('[WhatsApp] Erro ao gerar QRCode DataURL:', e);
          }
          console.log('\n[WhatsApp] 📲 NOVO QR CODE GERADO: Escaneie pelo WhatsApp do celular:');
          qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMessage = lastDisconnect?.error?.message || '';
          const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
          const isReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;

          console.log(`[WhatsApp] Conexão fechada. Código: ${statusCode || 'N/A'}${errorMessage ? ' (' + errorMessage + ')' : ''}`);

          this.status = 'DISCONNECTED';
          this.qrCodeRaw = null;
          this.qrCodeDataUrl = null;
          this.userProfile = null;
          this.connectedSince = null;

          if (isReplaced) {
            // PROTEÇÃO CRÍTICA DE DEPLOY:
            // Código 440 acontece quando o novo container do Render sobe e assume a sessão enquanto o antigo ainda está desligando.
            // NUNCA devemos apagar o backup do Supabase aqui!
            console.log('[WhatsApp] ℹ️ Código 440 (Sessão assumida por outra instância / novo deploy). Mantendo backup intacto no Supabase.');
            await this.cleanupSocket();
            // Aguardar 35s em silêncio: se esta for a instância antiga do Render, ela já terá sido encerrada;
            // se for a instância ativa que sofreu colisão momentânea, ela recarrega do Supabase após o container antigo morrer.
            this.scheduleReconnect(35000, true);
          } else if (isLoggedOut) {
            console.log('[WhatsApp] ⚠️ Aparelho desconectado manualmente pelo celular (Logout 401). Limpando credenciais para gerar novo QR Code...');
            await this.wipeAuthFolder(true);
            this.scheduleReconnect(2000);
          } else if (isRestartRequired) {
            console.log('[WhatsApp] 🔄 Reinício solicitado pelo WhatsApp (515). Reconectando rapidamente...');
            this.scheduleReconnect(1500);
          } else {
            console.log('[WhatsApp] ⏳ Oscilação temporária de rede. Reconectando em 5 segundos...');
            this.scheduleReconnect(5000);
          }
        } else if (connection === 'open') {
          console.log('[WhatsApp] ✅ CONECTADO COM SUCESSO AO WHATSAPP!');
          this.status = 'CONNECTED';
          this.connectedSince = new Date().toISOString();
          this.qrCodeRaw = null;
          this.qrCodeDataUrl = null;
          this.userProfile = this.sock.user;
          this.cancelScheduledReconnect();

          this.scheduleSessionBackup(2000);
          setTimeout(() => {
            if (!this.isShuttingDown && this.status === 'CONNECTED') {
              this.backupSessionToSupabase();
            }
          }, 15000);

          setTimeout(() => this.getGroups(true), 2500);
        }
      });

      this.isInitializing = false;
      return true;
    } catch (error) {
      console.error('[WhatsApp] Erro na inicialização:', error);
      this.status = 'DISCONNECTED';
      this.isInitializing = false;
      this.scheduleReconnect(6000);
      return false;
    }
  }

  async wipeAuthFolder(alsoClearCloud = false) {
    try {
      if (fs.existsSync(AUTH_FOLDER)) {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
        console.log('[WhatsApp] 🗑️ Pasta auth_info_baileys limpa com sucesso.');
      }
      if (alsoClearCloud) {
        await this.clearSessionBackupInSupabase();
      }
    } catch (e) {
      console.warn('[WhatsApp] Aviso ao remover pasta de credenciais:', e.message);
    }
  }

  async logout() {
    return await this.resetSession();
  }

  async resetSession() {
    console.log('\n[WhatsApp] 🔄 Resetando sessão manualmente...');
    this.cancelScheduledReconnect();

    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        await this.sock.logout().catch(() => {});
        this.sock.end(undefined);
      } catch (_) {}
      this.sock = null;
    }

    await this.wipeAuthFolder(true);

    this.status = 'DISCONNECTED';
    this.connectedSince = null;
    this.qrCodeRaw = null;
    this.qrCodeDataUrl = null;
    this.userProfile = null;
    this.groupsCache = [];
    this.isInitializing = false;

    setTimeout(() => {
      this.init();
    }, 1000);

    return true;
  }

  async getGroups(forceRefresh = false) {
    if (this.status !== 'CONNECTED' || !this.sock) {
      return this.groupsCache;
    }

    const now = Date.now();
    if (!forceRefresh && (now - this.lastGroupsFetch < 30000) && this.groupsCache.length > 0) {
      return this.groupsCache;
    }

    try {
      const groupsMap = await this.sock.groupFetchAllParticipating();
      const list = Object.values(groupsMap).map(g => ({
        id: g.id,
        subject: g.subject || 'Sem Nome',
        participantsCount: g.participants?.length || 0,
        creation: g.creation,
        owner: g.owner
      }));
      list.sort((a, b) => a.subject.localeCompare(b.subject));
      this.groupsCache = list;
      this.lastGroupsFetch = now;
      return list;
    } catch (err) {
      console.error('[WhatsApp] Erro ao buscar grupos participantes:', err.message);
      return this.groupsCache;
    }
  }

  async sendTextMessage(targetJid, text) {
    if (this.status !== 'CONNECTED' || !this.sock) {
      throw new Error('WhatsApp não está conectado no momento.');
    }
    const formattedJid = targetJid.includes('@') ? targetJid : `${targetJid}@g.us`;
    const result = await this.sock.sendMessage(formattedJid, { text });
    this.scheduleSessionBackup(10000);
    return result;
  }

  async sendImageMessage(targetJid, imageBufferOrUrl, caption = '') {
    if (this.status !== 'CONNECTED' || !this.sock) {
      throw new Error('WhatsApp não está conectado no momento.');
    }

    const formattedJid = targetJid.includes('@') ? targetJid : `${targetJid}@g.us`;
    const payload = {
      image: Buffer.isBuffer(imageBufferOrUrl) ? imageBufferOrUrl : { url: imageBufferOrUrl },
      caption: caption
    };

    const result = await this.sock.sendMessage(formattedJid, payload);
    this.scheduleSessionBackup(10000);
    return result;
  }

  getStatus() {
    return {
      status: this.status,
      connected: this.status === 'CONNECTED',
      connectedSince: this.connectedSince,
      qrCodeDataUrl: this.qrCodeDataUrl,
      user: this.userProfile ? {
        id: this.userProfile.id,
        name: this.userProfile.name || this.userProfile.notify || 'Instância Ativa'
      } : null
    };
  }
}

const instance = new WhatsAppManager();
module.exports = instance;
