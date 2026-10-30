module.exports = {
  apps: [
    {
      name: 'trade-marketing-whatsapp',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 3000
      },
      error_file: './data/logs/pm2-err.log',
      out_file: './data/logs/pm2-out.log',
      time: true
    }
  ]
};
