# ⚡ Trade Marketing Hub: Automação Umov.me ➔ WhatsApp

Sistema completo e autônomo desenvolvido para agências de Trade Marketing para receber eventos de finalização de atividades via webhook da **uMov.me** e disparar automaticamente as fotos registradas pelos promotores nos grupos correspondentes de **WhatsApp**, com proteção anti-ban e operação 24 horas por dia.

---

## 🌟 Recursos Principais

- **Recepção de Webhook 24h (`/api/webhook/umovme`)**: Processa atividades finalizadas da uMov.me, coletando nome do promotor, PDV/loja, data/hora, checklist e todas as fotos.
- **Motor Nativo WhatsApp (Zero Dependência de Docker)**: Utiliza Baileys integrado com geração de QR Code direto no navegador e no terminal, mantendo a sessão salva para reinicializações automáticas.
- **Compatibilidade com Evolution API**: Também suporta envio através de uma instância externa da Evolution API se configurada.
- **Fila Anti-Ban & Anti-Flood**: Envio sequencial de imagens com delays humanos aleatórios (3 a 7 segundos) entre mídias para proteger o número contra bloqueios do WhatsApp.
- **Roteamento Inteligente de Grupos**: Mapeie regras automáticas por nome do PDV (ex: *"Carrefour"* ➔ *Grupo Carrefour*), código da loja, marca/cliente ou utilize um grupo geral de fallback.
- **Dashboard Web Premium**: Interface escura moderna com monitoramento ao vivo, lista de grupos, cadastro de regras, feed de fotos e simulador de testes.
- **Simulador de Atividades**: Dispare testes em 1 clique com fotos reais para homologar sem depender de promotores em campo.
- **Operação Contínua 24/7**: Suporte a gerenciamento por PM2 ou Windows Service com auto-recuperação.

---

## 🚀 Como Iniciar

### 1. Iniciar o Servidor
No terminal, na pasta do projeto:
```bash
npm start
```

O sistema exibirá:
```
======================================================
🚀 Trade Marketing - Automação Umov.me ➔ WhatsApp
📡 Painel Web & Dashboard: http://localhost:3000
🔗 Webhook uMov.me: http://localhost:3000/api/webhook/umovme
======================================================
```

### 2. Acessar o Dashboard
Abra o navegador em: [http://localhost:3000](http://localhost:3000)

1. Vá na aba **📱 Conexão WhatsApp** e aponte a câmera do seu WhatsApp para escanear o QR Code.
2. Após conectar, acesse a aba **👥 Grupos do WhatsApp** para visualizar todos os grupos que a conta participa.
3. Copie o ID (JID) do grupo desejado ou clique em **➕ Criar Regra** para associar ao nome de uma loja (ex: *Pão de Açúcar*, *Carrefour*, *Assaí*).
4. Na aba **🧪 Simulador de Testes**, clique em **Disparar Atividade de Teste** para ver a mensagem e fotos chegando instantaneamente no grupo!

---

## 🔗 Configuração do Webhook na uMov.me

No painel de administração da **uMov.me**:
1. Acesse **Configurações / Integrações / Webhooks / Callbacks**.
2. Cadastre uma nova notificação para o evento: **Atividade Finalizada**.
3. No campo **URL de Destino**, insira a sua URL pública:
   ```
   https://seu-dominio-ou-tunel.com/api/webhook/umovme
   ```
4. Método HTTP: `POST` | Tipo de Conteúdo: `application/json`.

---

## 🌐 Operação Contínua 24 Horas por Dia

Para manter a aplicação funcionando 24h sem interrupção:

### Opção A: Executar em Segundo Plano com PM2 (Recomendado)
O PM2 reinicia o processo automaticamente caso ocorra queda de energia ou falha:
```bash
# Iniciar o serviço
npx pm2 start ecosystem.config.js

# Salvar para inicialização automática
npx pm2 save
```

### Opção B: Exposição Externa Gratuita 24h via Cloudflare Tunnel
Caso sua máquina local ou servidor não tenha IP público fixo, você pode usar o **Cloudflare Tunnel** para receber os webhooks da uMov.me com HTTPS:
```bash
npx cloudflared tunnel --url http://localhost:3000
```
A Cloudflare fornecerá uma URL pública gratuita como:
`https://exemplo-aleatorio.trycloudflare.com/api/webhook/umovme` para cadastrar na uMov.me.

---

## 📁 Estrutura de Arquivos

```
c:\Users\TRADE\Desktop\evolution\
├── config/
│   ├── mappings.json      # Regras de roteamento (PDV ➔ Grupo WhatsApp)
│   └── settings.json      # Delays anti-ban, templates de legenda e fallback
├── data/
│   └── history.json       # Histórico de atividades recebidas e status
├── public/                # Dashboard Frontend
│   ├── css/style.css      # Design system moderno Dark-mode
│   ├── js/app.js          # Lógica do painel com auto-refresh
│   └── index.html         # Painel administrativo
├── src/
│   ├── server.js          # Servidor Express & Rotas de Webhook
│   ├── whatsapp.js        # Motor Baileys de WhatsApp (QR Code e envio)
│   ├── queue.js           # Fila de despacho anti-ban e controle de taxa
│   ├── parser.js          # Parser flexível para payloads da uMov.me
│   ├── router.js          # Roteador de regras e legendas de fotos
│   ├── storage.js         # Gerenciamento de persistência de dados
│   └── evolutionClient.js # Adaptador opcional para Evolution API externa
├── ecosystem.config.js    # Configuração PM2 para 24/7
├── package.json
└── README.md
```
