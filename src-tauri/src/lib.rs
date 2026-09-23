use std::process::{Child, Command};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::net::TcpStream;
use std::io::{Read, Write};
use std::time::{Duration, Instant};
use tauri::Manager;

/* 轮询等待本地服务端口就绪（Python 冷启动可能需要数秒，
   此前 WebView 立即导航会命中"连接拒绝"错误页，表现为
   启动时只有一层透明边框、且需手动操作后才恢复） */
fn wait_for_port(host: &str, port: u16, timeout: Duration) -> bool {
    let addr = format!("{}:{}", host, port);
    let start = Instant::now();
    loop {
        if TcpStream::connect(&addr).is_ok() {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/* ★ TCP 可连 ≠ HTTP 可用：Python 监听后仍需数秒初始化（导入依赖、建路由），
   该阶段请求会挂起或直接失败。发一个极简 GET 验证状态码为 200。 */
fn http_probe_ok(port: u16, path: &str, timeout: Duration) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    if let Ok(mut stream) = TcpStream::connect(&addr) {
        let _ = stream.set_read_timeout(Some(timeout));
        let _ = stream.set_write_timeout(Some(timeout));
        let req = format!(
            "GET {} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            path
        );
        if stream.write_all(req.as_bytes()).is_ok() {
            let mut buf = [0u8; 128];
            if let Ok(n) = stream.read(&mut buf) {
                let head = String::from_utf8_lossy(&buf[..n]);
                return head.starts_with("HTTP/1.1 200")
                    || head.starts_with("HTTP/1.0 200");
            }
        }
    }
    false
}

fn wait_for_http(port: u16, path: &str, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if http_probe_ok(port, path, Duration::from_millis(1500)) {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

/* ★ 前端就绪信标：index.html 内联脚本在 DOMContentLoaded 时调用 page_loaded。
   Rust 端据此确认"页面真的加载成功"，避免把连接错误页当成加载完成。 */
static PAGE_LOADED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn page_loaded() {
    PAGE_LOADED.store(true, Ordering::SeqCst);
}

struct SidecarState {
    children: Mutex<Vec<Child>>,
    running: AtomicBool,
}

// 从可执行文件路径定位到工程根目录, 规避启动时 CWD 不在工程根导致相对路径失效
fn project_root() -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.parent()?
        .parent()?
        .parent()?
        .parent()
        .map(|p| p.to_path_buf())
}

// ★ 便携版（绿色版）仓库根：EXE 同级目录 == server.exe / runtime / web / _eval 所在目录
fn app_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_default()
}

// 直接 spawn 后端(8001) 与识曲 node(18089), 各自独立进程, 避免 cmd && 串行阻塞
// ★ 绿色版：EXE 同级 server.exe（PyInstaller 产物）+ runtime/node.exe（便携 Node），零依赖 PATH
//   dev 环境：回退 PATH 里的 python/python3 与 node，保持开发体验
// ★ 所有子进程必须隐藏控制台（CREATE_NO_WINDOW）：主窗口是透明无边框窗，
//   若子 spawn 的 console 程序（node.exe）冒出新黑框会破坏整体观感。
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}
fn spawn_sidecars() -> (Option<Child>, Option<Child>) {
    let root = match project_root() {
        Some(r) => r,
        None => {
            eprintln!("[sidecar] cannot resolve project root");
            return (None, None);
        }
    };
    let app = app_dir();

    let py_cmd = {
        let bundled_server = app.join("server.exe");
        if bundled_server.is_file() {
            // 绿色版：server.exe 的 PyInstaller PROJECT_DIR == exe 所在目录 == app
            hide_console(Command::new(&bundled_server).current_dir(&app)).spawn()
        } else {
            #[cfg(target_os = "windows")]
            let p = hide_console(Command::new("python").current_dir(&root).arg("server.py")).spawn();
            #[cfg(not(target_os = "windows"))]
            let p = Command::new("python3").current_dir(&root).arg("server.py").spawn();
            p
        }
    };

    let node_cmd = {
        let bundled_node = app.join("runtime").join("node.exe");
        if bundled_node.is_file() {
            // 绿色版：便携 node + exe 同级 scripts/
            hide_console(Command::new(&bundled_node)
                .current_dir(&app)
                .arg("scripts/shazam-server.mjs")).spawn()
        } else {
            #[cfg(target_os = "windows")]
            let n = hide_console(Command::new("node").current_dir(&root).arg("scripts/shazam-server.mjs")).spawn();
            #[cfg(not(target_os = "windows"))]
            let n = Command::new("node").current_dir(&root).arg("scripts/shazam-server.mjs").spawn();
            n
        }
    };

    match py_cmd {
        Ok(c) => (Some(c), node_cmd.ok()),
        Err(e) => {
            eprintln!("[sidecar] server spawn failed: {e}");
            (None, node_cmd.ok())
        }
    }
}

fn start_sidecar(state: &tauri::State<'_, SidecarState>) -> bool {
    let mut children = state.children.lock().unwrap();
    if state.running.load(Ordering::SeqCst) && !children.is_empty() {
        return true;
    }
    let (py, node) = spawn_sidecars();
    if let Some(c) = py {
        children.push(c);
    }
    if let Some(c) = node {
        children.push(c);
    }
    let ok = !children.is_empty();
    state.running.store(ok, Ordering::SeqCst);
    children.len() > 0
}

#[tauri::command]
fn sidecar_status(state: tauri::State<'_, SidecarState>) -> bool {
    state.running.load(Ordering::SeqCst)
}

#[tauri::command]
fn sidecar_start(state: tauri::State<'_, SidecarState>) -> bool {
    start_sidecar(&state)
}

// ★ 进程树清理：关窗后 server.exe / node 副进程必须回收，否则端口残留
//   （历史缺陷：只能靠 StopAria.bat 手动清）。Windows 用 taskkill /T 连子进程树
//   一起杀 —— server 派生的 vendor node(3100/3200/3201) 也在其树内，一并回收。
fn kill_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("taskkill");
        hide_console(&mut cmd)
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .status()
            .ok();
    }
    let _ = child.kill();
    let _ = child.wait();
}

// ★ 关窗前通知 8001 优雅退出（触发 server.py → selfhost_service.shutdown_all
//   清理自建 vendor），随后由 kill_tree 强杀进程树兜底。非阻塞，忽略结果。
fn request_shutdown(port: u16) {
    std::thread::spawn(move || {
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = s.set_read_timeout(Some(Duration::from_millis(1200)));
            let _ = s.set_write_timeout(Some(Duration::from_millis(1200)));
            let _ = s.write_all(
                b"GET /api/shutdown HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            );
        }
    });
}

#[tauri::command]
fn sidecar_stop(state: tauri::State<'_, SidecarState>) -> bool {
    let mut children = state.children.lock().unwrap();
    for c in children.iter_mut() {
        kill_tree(c);
    }
    children.clear();
    state.running.store(false, Ordering::SeqCst);
    true
}

/* ================= 桌面歌词窗口控制 ================= */

#[tauri::command]
fn desktop_lyrics_show(
    app: tauri::AppHandle,
    show: bool,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let win = app
        .get_webview_window("desktop_lyrics")
        .ok_or_else(|| "desktop_lyrics window not found".to_string())?;
    if let (Some(x), Some(y)) = (x, y) {
        use tauri::LogicalPosition;
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
    if show {
        /* ★ 自愈：该窗口与主窗口同期创建，启动时服务未就绪可能停在连接错误页。
           显示前若当前 URL 不是 lyrics.html 则补一次导航，避免桌面歌词空白。 */
        if let Ok(cur) = win.url() {
            if cur.path() != "/lyrics.html" {
                /* ★ 必须用 localhost 而不是 127.0.0.1：Gemini 反代 Worker
                   （docs/cf-gemini-auth-worker.js）有 ALLOWED_ORIGINS 来源白名单，
                   线上配置是 http://localhost:8001。改用 127.0.0.1 会让浏览器的
                   Origin 变成 http://127.0.0.1:8001 → 403 "Forbidden: origin not allowed"
                   （AI 功能整体失效）。后端仍只绑 127.0.0.1 回环，安全性不受影响。 */
                if let Ok(u) = tauri::Url::parse("http://localhost:8001/lyrics.html") {
                    let _ = win.navigate(u);
                }
            }
        }
        let _ = win.show();
        let _ = win.set_always_on_top(true);
    } else {
        let _ = win.hide();
    }
    Ok(())
}

#[tauri::command]
fn desktop_lyrics_move(win: tauri::WebviewWindow, x: f64, y: f64) -> Result<(), String> {
    use tauri::LogicalPosition;
    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_lyrics_pos(win: tauri::WebviewWindow) -> Result<(f64, f64), String> {
    let p = win.outer_position().map_err(|e| e.to_string())?;
    let sc = win.scale_factor().unwrap_or(1.0).max(1.0) as f64;
    Ok((p.x as f64 / sc, p.y as f64 / sc))
}

/* ★ 锁定/解锁必须始终作用于 desktop_lyrics 窗口本身：
   此前参数为 win: WebviewWindow 时，Tauri 注入的是"调用方"窗口 ——
   主界面点解锁时实际改的是主窗口的穿透状态，歌词窗口永远保持穿透，
   表现为"控制按钮消失且无法解锁"。改为 AppHandle 显式取目标窗口。 */
#[tauri::command]
fn desktop_lyrics_click_through(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    let win = app
        .get_webview_window("desktop_lyrics")
        .ok_or_else(|| "desktop_lyrics window not found".to_string())?;
    win.set_ignore_cursor_events(enable)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_lyrics_start_drag(win: tauri::WebviewWindow) -> Result<(), String> {
    /* OS 原生拖拽：由 DWM 以 60fps+ 合成，彻底杜绝 IPC 抖动/闪烁/跟手差 */
    win.start_dragging()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_lyrics_resize(
    win: tauri::WebviewWindow,
    w: f64,
    h: f64,
    x: Option<f64>,
) -> Result<(), String> {
    /* ★ 改为「绝对锚点定位」：横向位置 X 由前端按（锚点中点 − 新宽/2）算好后传进来，
       这里只做大→物理像素换算与设值，**不再读当前位置做增量平移**。

       为什么必须这样：旧实现是
           `set_position(LogicalPosition(pos.x/scale + (old_w - w)/2, pos.y/scale))`
       即「当前 X + Δw/2」，而 outer_position() 给的是物理整数、set_position 又按 scale
       换算回物理整数，**往返每一步都可能有亚像素取整误差**；歌词每换一句宽度变化 >12px
       就会调一次 → 误差逐句累积，窗口看起来在缓慢漂移（屏幕缩放 ≠100% 时最明显），
       且被前端 savePos 每 3s 持久化，重启也回不去。

       锚点式下 X = f(锚点, 新宽)，与当前 X 无关 → 重复调用结果完全相同，不可能累积。

       x = None（冷启动/锚点未知）：只改尺寸、保持左边缘不挪位，与旧「防重启右漂」一致。
       Y 用 outer_position() 的**物理整数原样回传**，避免 Y 也被取整逻辑带偏。 */
    use tauri::{LogicalSize, PhysicalPosition};
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    win.set_size(LogicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    if let Some(xl) = x {
        let scale = win.scale_factor().map_err(|e| e.to_string())?;
        let x_phys = (xl * scale).round() as i32;
        win.set_position(PhysicalPosition::new(x_phys, pos.y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState {
            children: Mutex::new(Vec::new()),
            running: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            sidecar_start,
            sidecar_stop,
            page_loaded,
            desktop_lyrics_show,
            desktop_lyrics_move,
            desktop_lyrics_pos,
            desktop_lyrics_click_through,
            desktop_lyrics_start_drag,
            desktop_lyrics_resize
        ])
        .setup(|app| {
            // 启动时确定性拉起 Python(8001)/Node(18089) sidecar,
            // 不依赖前端加载时机; 前端 fetch 侧仍会重试
            let state = app.state::<SidecarState>();
            if !start_sidecar(&state) {
                eprintln!("[sidecar] auto-start failed; frontend may retry via sidecar_start");
            }
            /* ★ 启动体验修复：主窗口配置为 visible:false，此处等待 Python 服务
               真正可响应 HTTP 后再导航并显示窗口。用户看到窗口时页面已可交互，
               不再出现"透明边框/长时间白屏/标题栏延迟出现"。
               ★ 导航以 page_loaded 信标确认成功，失败自动重试（最多 3 次），
                 杜绝首次导航命中半就绪服务或 WebView 未初始化竞态后停在错误页。 */
            if let Some(window) = app.get_webview_window("main") {
                window.hide().ok();
                let win = window.clone();
                std::thread::spawn(move || {
                    let ready = wait_for_port("127.0.0.1", 8001, Duration::from_secs(45));
                    if !ready {
                        eprintln!("[sidecar] server not ready within timeout, showing window anyway");
                        let _ = win.show();
                        let _ = win.set_focus();
                        return;
                    }
                    /* TCP 就绪后再等 HTTP 200（Python listen 后仍在初始化） */
                    if !wait_for_http(8001, "/index.html", Duration::from_secs(30)) {
                        eprintln!("[sidecar] http probe failed within timeout, showing window anyway");
                    }
                    /* ★ 同 lyrics.html：窗口必须走 localhost —— AI 反代 Worker 的来源
                       白名单只放行 http://localhost:8001，用 127.0.0.1 会 403。 */
                    if let Ok(url) = tauri::Url::parse("http://localhost:8001/index.html") {
                        for attempt in 1..=3 {
                            PAGE_LOADED.store(false, Ordering::SeqCst);
                            if let Err(e) = win.navigate(url.clone()) {
                                eprintln!("[boot] navigate attempt {} error: {}", attempt, e);
                            }
                            /* 等待前端信标确认加载成功 */
                            let deadline = Instant::now() + Duration::from_secs(if attempt == 1 { 6 } else { 4 });
                            while Instant::now() < deadline {
                                if PAGE_LOADED.load(Ordering::SeqCst) { break; }
                                std::thread::sleep(Duration::from_millis(150));
                            }
                            if PAGE_LOADED.load(Ordering::SeqCst) {
                                break;
                            }
                            eprintln!("[boot] page load not confirmed (attempt {}), retrying", attempt);
                        }
                    }
                    let _ = win.show();
                    let _ = win.set_focus();
                });
            }
            // 显式设置窗口图标，确保任务栏使用 Aria logo 而非 Tauri 默认图标
            if let Some(window) = app.get_webview_window("main") {
                let icon_bytes = include_bytes!("../icons/icon.png");
                if let Ok(dyn_img) = image::load_from_memory(icon_bytes) {
                    let rgba = dyn_img.to_rgba8();
                    let (w, h) = rgba.dimensions();
                    let tauri_img = tauri::image::Image::new(rgba.as_raw(), w, h);
                    let _ = window.set_icon(tauri_img);
                    let _ = window.set_title("Aria");
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            /* ★ 进程回收：关窗/退出时先通知 8001 优雅清理（vendor/shazam 副进程），
               随即 taskkill 强杀 sidecar 进程树兜底 —— 修「关窗即退出但 node
               副进程全部残留、只能手动 StopAria.bat 清理」的历史硬缺陷。 */
            if let tauri::RunEvent::ExitRequested { .. } = event {
                request_shutdown(8001);
                std::thread::sleep(Duration::from_millis(350));
                if let Some(state) = app.try_state::<SidecarState>() {
                    let mut children = state.children.lock().unwrap();
                    for c in children.iter_mut() {
                        kill_tree(c);
                    }
                    children.clear();
                    state.running.store(false, Ordering::SeqCst);
                }
            }
        });
}
