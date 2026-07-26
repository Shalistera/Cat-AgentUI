module.exports = {
  apps: [
    {
      name: 'cat-agentui',
      cwd: `${__dirname}/../server`,
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork', // SQLite: single writer process
      max_memory_restart: '1024M',
      env: { NODE_ENV: 'production' },
      out_file: `${__dirname}/../data/logs/out.log`,
      error_file: `${__dirname}/../data/logs/err.log`,
      merge_logs: true,
      time: true,
    },
  ],
};
