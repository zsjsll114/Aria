fn main() {
    /* ★ Tauri 2.11 ACL：远程页面(http://localhost:8001)调用应用自定义命令
       必须显式授权（webview/mod.rs: "remote content can never reach custom
       commands unless an explicit remote capability has been configured"），
       否则 invoke 报 "xxx not allowed. Plugin not found"。
       通过 AppManifest::commands 为每个命令自动生成 allow-<command> 权限，
       再在 tauri.conf.json 的能力(capabilities)中引用这些权限。 */
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "sidecar_status",
            "sidecar_start",
            "sidecar_stop",
            "page_loaded",
            "desktop_lyrics_show",
            "desktop_lyrics_move",
            "desktop_lyrics_pos",
            "desktop_lyrics_click_through",
            "desktop_lyrics_start_drag",
            "desktop_lyrics_resize",
            /* 原生音频引擎（Phase 2b）。★ 这个清单必须与 lib.rs 的
               generate_handler! 严格一致 —— 漏一个不会编译失败，而是
               运行期 invoke 报 "not allowed"，只有真机点到那个功能才会发现。 */
            "native_audio_status",
            "native_audio_devices",
            "native_audio_check_exclusive",
            "native_audio_load",
            "native_audio_play",
            "native_audio_pause",
            "native_audio_seek",
            "native_audio_set_volume",
            "native_audio_set_eq",
            "native_audio_set_spatial",
            "native_audio_set_rate",
            "native_audio_set_output",
            "native_audio_snapshot",
            "native_audio_release_output",
        ])),
    )
    .unwrap()
}
