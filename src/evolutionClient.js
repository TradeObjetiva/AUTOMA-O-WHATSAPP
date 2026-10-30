const axios = require('axios');
const Storage = require('./storage');

class EvolutionApiClient {
  static getClientConfig() {
    const settings = Storage.getSettings();
    return {
      baseUrl: (settings.whatsapp?.evolutionApiUrl || '').replace(/\/$/, ''),
      apiKey: settings.whatsapp?.evolutionApiKey || '',
      instance: settings.whatsapp?.evolutionInstance || 'trade_mkt',
      enabled: settings.whatsapp?.engine === 'evolution'
    };
  }

  static async sendTextMessage(targetJid, text) {
    const config = this.getClientConfig();
    if (!config.baseUrl || !config.apiKey) {
      throw new Error('Evolution API não está configurada (URL ou API Key ausentes)');
    }

    const number = targetJid.replace('@g.us', '').replace('@s.whatsapp.net', '');
    const url = `${config.baseUrl}/message/sendText/${config.instance}`;

    const response = await axios.post(
      url,
      {
        number: targetJid.includes('@') ? targetJid : `${number}@g.us`,
        text: text
      },
      {
        headers: {
          apikey: config.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    return response.data;
  }

  static async sendImageMessage(targetJid, mediaUrlOrBase64, caption = '', fileName = 'foto.jpg') {
    const config = this.getClientConfig();
    if (!config.baseUrl || !config.apiKey) {
      throw new Error('Evolution API não está configurada (URL ou API Key ausentes)');
    }

    const number = targetJid.replace('@g.us', '').replace('@s.whatsapp.net', '');
    const url = `${config.baseUrl}/message/sendMedia/${config.instance}`;

    let mediaData = mediaUrlOrBase64;
    if (Buffer.isBuffer(mediaUrlOrBase64)) {
      mediaData = `data:image/jpeg;base64,${mediaUrlOrBase64.toString('base64')}`;
    }

    const response = await axios.post(
      url,
      {
        number: targetJid.includes('@') ? targetJid : `${number}@g.us`,
        media: mediaData,
        mediatype: 'image',
        mimetype: 'image/jpeg',
        caption: caption,
        fileName: fileName
      },
      {
        headers: {
          apikey: config.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data;
  }
}

module.exports = EvolutionApiClient;
