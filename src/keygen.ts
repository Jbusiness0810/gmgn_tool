import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Generates the Ed25519 key pair GMGN's "Create API Key" dialog asks for.
 *
 * Same location and file format as the official `gmgn-cli config` command
 * (~/.config/gmgn/keypair.pem, mode 600), so the pair is reused if you already
 * ran that — and gmgn-cli will pick this one up if you install it later.
 *
 * The PRIVATE key stays on this machine. It is only ever needed for trading
 * routes; this screener is read-only and never loads it. Upload only the
 * PUBLIC key printed below.
 */

const CONFIG_DIR = join(homedir(), ".config", "gmgn");
const KEYPAIR_FILE = join(CONFIG_DIR, "keypair.pem");

let publicPem: string;

if (existsSync(KEYPAIR_FILE)) {
  const content = readFileSync(KEYPAIR_FILE, "utf-8");
  const match = content.match(/(-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----)/);
  if (!match) {
    console.error(
      `Error: ${KEYPAIR_FILE} exists but no public key could be parsed from it.\n` +
        `Delete the file and run \`npm run keygen\` again to generate a fresh pair.`
    );
    process.exit(1);
  }
  publicPem = match[1]! + "\n";
  console.log(`Reusing the existing key pair at ${KEYPAIR_FILE}\n`);
} else {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEYPAIR_FILE, `# Private Key\n${privatePem}\n# Public Key\n${publicPem}\n`, {
    mode: 0o600,
  });
  console.log(`New Ed25519 key pair saved to ${KEYPAIR_FILE} — keep this file private.\n`);
}

console.log("─".repeat(64));
console.log("PUBLIC key — paste into GMGN's “Create API Key” dialog:\n");
console.log(publicPem.trim());
console.log("─".repeat(64));
console.log(
  `\nOr open this link to pre-fill it:\n` +
    `  https://gmgn.ai/ai/generateapi?pbk=${encodeURIComponent(publicPem)}\n\n` +
    `In the dialog: leave "Enable Reading" ON; "Enable Trading" is NOT needed\n` +
    `by this screener — leave it off unless you have other plans for the key.\n\n` +
    `After creating, copy the API key into gmgn-screener/.env:\n` +
    `  GMGN_API_KEY=<your key>\n` +
    `then run: npm start`
);
