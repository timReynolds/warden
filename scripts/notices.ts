import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = dirname(import.meta.dir);
const document = join(root, "THIRD_PARTY_NOTICES.txt");
type Package = {
  name: string;
  version: string;
  license: string;
  dependencies?: Record<string, string>;
};
const packages = new Map<string, { metadata: Package; text: string }>();

async function locate(name: string, from: string): Promise<string> {
  let directory = from;
  for (;;) {
    const candidate = join(directory, "node_modules", name);
    if (await Bun.file(join(candidate, "package.json")).exists())
      return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Dependency missing: ${name}`);
    directory = parent;
  }
}
async function collect(name: string, from: string): Promise<void> {
  const directory = await locate(name, from);
  const metadata: Package = await Bun.file(
    join(directory, "package.json"),
  ).json();
  const key = `${metadata.name}@${metadata.version}`;
  if (packages.has(key)) return;
  const licenses = (await readdir(directory))
    .filter((file) => /^(?:licen[cs]e|copying)(?:[.-].*)?$/i.test(file))
    .sort();
  const fallback = Bun.file(
    join(root, "licenses", `${key.replaceAll("/", "-")}.txt`),
  );
  if (!licenses.length && !(await fallback.exists()))
    throw new Error(`No licence text found for ${key}; review before release`);
  const text =
    (
      await Promise.all(
        licenses.map(async (file) =>
          (await Bun.file(join(directory, file)).text()).trim(),
        ),
      )
    ).join("\n\n") || (await fallback.text()).trim();
  packages.set(key, { metadata, text });
  for (const dependency of Object.keys(metadata.dependencies ?? {}).sort())
    await collect(dependency, directory);
}

const manifest = await Bun.file(join(root, "package.json")).json();
for (const name of Object.keys(manifest.dependencies).sort())
  await collect(name, root);
const contents = [
  "Warden third-party notices",
  "",
  "Generated from installed, locked production dependencies.",
  "Includes transitive packages, including type-only packages, conservatively.",
  "Warden's own licence is in LICENSE. Preserve these notices with bundled distributions.",
  "",
  ...[...packages.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, { metadata, text }]) => [
      key,
      "=".repeat(key.length),
      "",
      `Declared licence: ${metadata.license}`,
      "",
      text,
      "",
    ]),
].join("\n");
if (process.argv.includes("--check")) {
  if (
    !(await Bun.file(document).exists()) ||
    (await Bun.file(document).text()) !== contents
  )
    throw new Error(
      "Third-party notices are stale; run bun run notices and commit the result",
    );
  console.log(
    `Warden third-party notices verified (${packages.size} packages)`,
  );
} else {
  await Bun.write(document, contents);
  console.log(
    `Warden third-party notices generated (${packages.size} packages)`,
  );
}
