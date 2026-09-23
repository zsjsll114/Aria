// 防止 Windows release 模式下额外打开控制台窗口，不要删除！！
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lyrics_player_lib::run()
}
