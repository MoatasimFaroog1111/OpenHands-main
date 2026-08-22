import { loadConfig } from './config.js';
import { createGatewayServer } from './http-server.js';
import { RailwaySandboxPlatform } from './platform.js';
import { FileRuntimeRegistry } from './registry.js';
import { RuntimeService } from './runtime-service.js';

const config = loadConfig();
const registry = new FileRuntimeRegistry(config.registryPath);
const platform = new RailwaySandboxPlatform(
  config.railwayEnvironmentId,
  config.idleTimeoutMinutes,
);
const service = new RuntimeService(config, registry, platform);
const server = createGatewayServer(service, config.apiKey);

server.listen(config.port, '::', () => {
  console.log(`Railway Sandbox Gateway listening on port ${config.port}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
