module.exports = {
  apps: [
    {
      name: 'cse356',
      script: 'src/app.js',
      instances: 'max',
      exec_mode: 'cluster',
      env_file: '.env',
      // V8 heap capped at 384MB; PM2 RSS threshold at 1024MB allows ample
      // off-heap room (sockets, ws frame buffers, native pg/redis state).
      // Prior 512MB threshold was triggering ~18 silent SIGINT-restarts/25min
      // per worker — workers RSS would creep past 512MB even with V8 heap
      // bounded, dropping all live WS conns on each restart. Smaller young
      // gen keeps minor GC pauses short. On the 4GB nodes (217/149) with 4
      // PM2 workers each the worst-case RSS is 4×1024MB = 4GB; OS uses
      // 500MB-1GB for buff/cache so this is tight but acceptable since
      // workers won't all peak simultaneously. On node-72 (16GB, 8 workers)
      // worst case is 8GB out of 16GB — comfortable headroom.
      node_args: '--max-semi-space-size=8 --max-old-space-size=384',
      kill_timeout: 10000,
      listen_timeout: 5000,
      max_memory_restart: '1024M',
      error_file: '/var/log/pm2/cse356-error.log',
      out_file: '/var/log/pm2/cse356-out.log',
      merge_logs: true,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
