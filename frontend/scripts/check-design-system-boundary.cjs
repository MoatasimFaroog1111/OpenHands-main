const fs = require("node:fs");
const path = require("node:path");

const frontendRoot = path.resolve(__dirname, "..");
const migratedConsumers = [
  "src/components/shared/buttons/icon-button.tsx",
  "src/components/shared/buttons/trajectory-action-button.tsx",
];

const errors = [];

for (const relativePath of migratedConsumers) {
  const absolutePath = path.join(frontendRoot, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");

  if (source.includes('from "@heroui/react"') || source.includes("from '@heroui/react'")) {
    errors.push(
      `${relativePath} bypasses the design-system boundary with a direct HeroUI import.`,
    );
  }

  if (!source.includes("#/components/design-system")) {
    errors.push(
      `${relativePath} must consume migrated primitives from #/components/design-system.`,
    );
  }
}

const adapterDir = path.join(frontendRoot, "src/components/design-system");
for (const filename of ["button.tsx", "tooltip.tsx"]) {
  const source = fs.readFileSync(path.join(adapterDir, filename), "utf8");
  if (source.includes("../../../../openhands-ui") || source.includes("/openhands-ui/")) {
    errors.push(
      `src/components/design-system/${filename} must not import @openhands/ui source files by relative path.`,
    );
  }
}

if (errors.length > 0) {
  console.error("Design-system boundary check failed:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Design-system boundary check passed.");
