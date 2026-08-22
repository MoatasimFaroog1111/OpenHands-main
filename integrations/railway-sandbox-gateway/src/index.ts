import { loadConfig } from './config.js';
import { createGatewayServer } from './http-server.js';
import { RailwaySandboxPlatform } from './platform.js';
import { FileRuntimeRegistry } from './registry.js';
import { RuntimeService } from './runtime-service.js';

const config = loadConfig();
const registry = new FileRuntimeRegistry(config.registryPath, config.apiKey);
const platform = new RailwaySandboxPlatform(
  config.railwayEnvironmentId,
  config.idleTimeoutMinutes,
);
const service = new RuntimeService(config, registry, platform);
const server = createGatewayServer(service, config.apiKey);
let keepAliveRunning = false;
const keepAliveTimer = setInterval(() => {
  if (keepAliveRunning) return;
  keepAliveRunning = true;
  void service
    .keepAlive()
    .then(({ failed }) => {
      if (failed.length > 0) {
        console.error(`Railway sandbox keepalive failed for: ${failed.join(', ')}`);
      }
    })
    .catch((error) => {
      console.error('Railway sandbox keepalive cycle failed', error);
    })
    .finally(() => {
      keepAliveRunning = false;
    });
}, config.keepAliveSeconds * 1_000);
keepAliveTimer.unref();

server.listen(config.port, '::', () => {
  console.log(`Railway Sandbox Gateway listening on port ${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    clearInterval(keepAliveTimer);
    server.close(() => process.exit(0));
  });
}
