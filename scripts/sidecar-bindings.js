// Tauri dev/build 前的副挂: 核实 sidecar 端口约定与前端一致。
// 此脚本不启动 server, 剒引由 lib.rs 的 sidecar_start 控制。
const CONFIG = {
  pythonPort: 8001,
  nodePort: 18089,
  pythonProbe: '/proxy?url=', // 任意目标都可,内置跟躪 Logging
  nodeProbe: '/health'
};
try {
  console.log('[sidecar-bindings] python=%s node=%s', CONFIG.pythonPort, CONFIG.nodePort);
} catch (e) { console.info('[sidecar]', e && e.message); }
