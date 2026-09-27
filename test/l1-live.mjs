/**
 * 真跑起来的 Worker + 假 APNs，给 api-l1-e2e.test.mjs 用（文件名不以 api 开头：run-api.sh 不单独跑它）。
 *
 * run-api.sh 起的那个 wrangler dev 没有 APNs 私钥，投递一律 502 —— 看得到回话，看不到推出去的通知长什么样。
 * 这里另起一个：本地 wrangler dev（随机端口、独立的本地 KV 目录），APNS_HOST 指向本机的一个 HTTPS 服务，
 * 它记下每一条推送、一律回 200。Worker 出站走的是真的 TLS：证书现场用 openssl 签，经 NODE_EXTRA_CA_CERTS
 * 交给这个 wrangler 子进程信任；签推送 JWT 的 P-256 私钥也是现场生成的。临时文件用完即删。
 *
 * 从请求到 APNs 的整条路（路由、解析、限流、KV、签名、投递、回话）都是线上那一套，只有 APNs 是假的。
 */
import { execFileSync, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** 本机用的自签证书（同时当 CA）：localhost 和 127.0.0.1 都认。只活两天，只放在临时目录里 */
function makeCert(dir) {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", join(dir, "apns-key.pem"), "-out", join(dir, "apns-cert.pem"), "-days", "2", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(join(dir, "apns-key.pem")), cert: readFileSync(join(dir, "apns-cert.pem")), certPath: join(dir, "apns-cert.pem") };
}

/**
 * 起一套。返回：
 *   base       Worker 的地址（http://localhost:端口；Worker 里看到的是 https，见 wrangler.toml 的 [dev]）
 *   publicKey  签推送 JWT 的私钥对应的公钥（PEM），用来验签
 *   pushes     APNs 收到的每一条：{ token, headers, payload }（登记设备时的校验推送 probe 也在里面）
 *   take()     上次 take 之后新到的推送（不含 probe）
 *   tmp        这一套的临时目录：测试要的临时文件放这里，stop() 时一起删
 *   stop()     收摊
 */
export async function startLive() {
  const dir = mkdtempSync(join(tmpdir(), "pigeon-l1-live-"));
  const { key, cert, certPath } = makeCert(dir);

  const pushes = [];
  const apns = createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let payload = null;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        /* 不是 JSON：留 null，断言会看出来 */
      }
      pushes.push({ token: (req.url ?? "").replace(/^\/3\/device\//, ""), headers: req.headers, payload });
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve) => apns.listen(0, "127.0.0.1", resolve));

  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const port = await freePort();
  const noProxy = "localhost,127.0.0.1,::1";
  // APNS_HOST 写 IP 不写 localhost：CI 的 Linux 上 localhost 先解析成 ::1，而假 APNs 只听 127.0.0.1。
  // 起法和 api-l4-e2e 一样（node 直接跑 wrangler.js，不另指定调试端口）：原先 npx 加 --inspector-port，
  // 在 CI 的 Linux 上 Worker 启动后对任何请求都不回话，测试一直挂到超时（2026-09-27 CI 因此失败两次）
  const child = spawn(
    process.execPath,
    [
      join(ROOT, "node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "--port", String(port),
      "--persist-to", join(dir, "state"),
      "--var", `APNS_HOST:127.0.0.1:${apns.address().port}`, "--var", `APNS_KEY_P8:${privateKey}`, "--var", "PIGEON_TEST_ADMIN:1",
    ],
    {
      cwd: ROOT,
      // 自成一个进程组：收摊时连 wrangler 起的 workerd 一起结束
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath, NO_PROXY: noProxy, no_proxy: noProxy },
    },
  );
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* 已经退出了 */
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 已经退出了 */
        }
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await new Promise((resolve) => apns.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  };
  process.once("exit", () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* 已经退出了 */
    }
  });

  for (let i = 0; i < 120 && !log.includes("Ready on http"); i++) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!log.includes("Ready on http")) {
    await stop();
    throw new Error(`wrangler dev 起不来：\n${log.slice(-2000)}`);
  }

  let cursor = 0;
  const take = () => {
    const fresh = pushes.slice(cursor).filter((p) => p.payload?.probe !== "1");
    cursor = pushes.length;
    return fresh;
  };
  return { base: `http://localhost:${port}`, publicKey, pushes, take, stop, tmp: dir, log: () => log };
}
