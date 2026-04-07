module.exports = {
  apps: [
    {
      name: 'cse356',
      script: 'src/app.js',
      instances: 'max',
      exec_mode: 'cluster',
      env_file: '.env',
      kill_timeout: 10000,
      listen_timeout: 5000,
      max_memory_restart: '512M',
      error_file: '/var/log/pm2/cse356-error.log',
      out_file: '/var/log/pm2/cse356-out.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
