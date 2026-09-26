// PM2 definitions for interpres on solwatch.
//
//   interpres         the node server on 127.0.0.1:3031. It runs serve.ts, not
//                     index.ts: PM2's fork container imports the script, so
//                     index.ts's isMain guard never fires under PM2. Measured
//                     through PM2 7.0.1's own container: index.ts printed
//                     nothing and exited 0.
//   interpres-tunnel  a dedicated cloudflared, the cassum/overhang/visum shape.
//                     The shared config.yml and every running cloudflared are
//                     left alone.
//
// `interpreter: 'node'` is required: PM2 maps .ts to bun by default
// (lib/API/interpreter.json), and there is no bun on the box.
//
// The API key stays in /opt/interpres/.env, which node reads through
// --env-file at every start, so it never lands in PM2's dump file.
//
// Cycle with `pm2 delete` then `pm2 start`, never the in-place verb.
module.exports = {
  apps: [
    {
      name: 'interpres',
      script: 'apps/server/src/serve.ts',
      interpreter: 'node',
      node_args: ['--env-file=/opt/interpres/.env'],
      cwd: '/opt/interpres',
      env: {
        NODE_ENV: 'production',
        // 127.0.0.1 only: the box has no host firewall.
        HOST: '127.0.0.1',
        PORT: '3031',
        // The public demo's spend guard. A session is capped at 300 s, which at
        // $4.50/hr is $0.375, so the worst case is 100 x $0.375 = $37.50 per
        // UTC day (the code default of 400 would allow $150, the whole credit).
        // In-memory: a delete + start resets the day's count.
        MAX_SESSION_SECONDS: '300',
        RATE_PER_IP_HOUR: '6',
        RATE_GLOBAL_DAY: '100',
      },
      // About 1 GB is free on the box: a leak here must never starve the
      // protected services, so PM2 recycles this process first.
      max_memory_restart: '250M',
      autorestart: true,
      time: true,
    },
    {
      name: 'interpres-tunnel',
      script: '/usr/local/bin/cloudflared',
      args: ['tunnel', '--config', '/root/.cloudflared/interpres.yml', '--no-autoupdate', 'run'],
      cwd: '/root',
      autorestart: true,
    },
  ],
};
