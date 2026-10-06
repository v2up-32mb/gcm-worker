// 测试替身：替代 `cloudflare:sockets` 的 connect()。
//
// esbuild 打包测试产物时把 `cloudflare:sockets` 解析到本文件；状态放在
// globalThis.__CF_STUB__ 上，以便测试文件与被打包后的 worker 模块共享同一份控制面。
//
// policy(opts, rec) 决定每个连接的行为：
//   "open"    —— opened 立即兑现（默认）
//   "reject"  —— opened 拒绝（连接被拒）
//   "hang"    —— opened 永不结算（触发 connectTimeout 超时路径）
// 其它返回值视为未知 → 按 "reject" 处理。
//
// hooks.write(rec, chunk) —— 注入写延迟（返回 promise 则等待）或写失败（抛错）。
//   真实 socket 的 write 天然跨任务结算，替身若同步 push 会掩盖写序竞态，故默认也是异步的。
// rec.failToClient(err)   —— 让远端 → 客户端方向以错误结束（模拟 RST）。

function state() {
  if (!globalThis.__CF_STUB__) {
    globalThis.__CF_STUB__ = {
      sockets: [],
      policy: null,
      hooks: { write: null },
      reset() {
        this.sockets = [];
        this.policy = null;
        this.hooks = { write: null };
      },
    };
  }
  return globalThis.__CF_STUB__;
}

export function connect(opts) {
  const s = state();
  const rec = {
    opts,
    closed: false,
    toTarget: [], // 客户端 DATA 经 writable 写入的字节
    writes: 0,
    resolveOpened: null,
    rejectOpened: null,
    enqueueToClient: null,
    eofToClient: null,
    failToClient: null,
  };
  s.sockets.push(rec);

  let openedResolve, openedReject;
  const opened = new Promise((res, rej) => {
    openedResolve = res;
    openedReject = rej;
  });
  // 未处理的 opened 拒绝不应影响测试进程
  opened.catch(() => {});

  // Cloudflare 语义：`socket.opened` 兑现的是**内部对象**（不是 socket 本身，
  // 无 readable/writable/close）。真实 workerd 实测：`await socket.opened` 得到
  // 一个 object 且 `v === socket` 为 false。任何写成
  // `const s = await socket.opened; s.writable.getWriter()` 的代码线上必崩
  // （"Cannot read properties of undefined (reading 'getWriter')"），
  // 故此处刻意不给 socket，让该误用在用例里当场暴露而不是被替身掩盖。
  rec.resolveOpened = () => openedResolve(Object.freeze({ __openedSentinel: true }));
  rec.rejectOpened = (err) => openedReject(err || new Error("connect refused"));

  const socket = {
    opened,
    readable: new ReadableStream({
      start(controller) {
        rec.enqueueToClient = (bytes) => controller.enqueue(new Uint8Array(bytes));
        rec.eofToClient = () => {
          try {
            controller.close();
          } catch {}
        };
        rec.failToClient = (err) => {
          try {
            controller.error(err || new Error("read error"));
          } catch {}
        };
      },
      cancel() {
        rec.enqueueToClient = null;
        rec.eofToClient = null;
        rec.failToClient = null;
      },
    }),
    writable: new WritableStream({
      async write(chunk) {
        if (s.hooks.write) await s.hooks.write(rec, chunk);
        rec.writes++;
        rec.toTarget.push(new Uint8Array(chunk));
      },
    }),
    close() {
      if (rec.closed) return;
      rec.closed = true;
      try {
        rec.rejectOpened(new Error("socket closed"));
      } catch {}
      try {
        rec.eofToClient?.();
      } catch {}
    },
  };

  const mode = s.policy ? s.policy(opts, rec) : "open";
  if (mode === "open") rec.resolveOpened();
  else if (mode === "hang") {
    /* 保持 pending，等 worker 侧超时 */
  } else rec.rejectOpened(new Error(`connect refused: ${opts.hostname}:${opts.port}`));

  rec.socket = socket; // 供用例核对「opened 兑现值 ≠ socket」这一真实 workerd 语义
  return socket;
}
