import os
import sys
import json
import base64
import re
import urllib.request
import urllib.parse
import shutil
import time

# ★ PyInstaller 打包（绿色版）时：EXE 所在目录 == 绿色版根目录（local_music 数据目录相对它找）
if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOCAL_MUSIC_DIR = os.path.join(BASE_DIR, 'local_music')

# 确保 local_music 目录存在
os.makedirs(LOCAL_MUSIC_DIR, exist_ok=True)

def sanitize_filename(name):
    """移除 Windows / Linux 文件名非法字符"""
    if not name or not name.strip():
        return "未知歌曲"
    clean = re.sub(r'[\\/*?:"<>|]', '_', name.strip())
    return clean[:80]

def list_local_songs():
    """扫描 local_music 目录，返回所有结构化单曲"""
    songs = []
    if not os.path.exists(LOCAL_MUSIC_DIR):
        return songs

    audio_exts = {'.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac'}

    for folder_name in sorted(os.listdir(LOCAL_MUSIC_DIR)):
        folder_path = os.path.join(LOCAL_MUSIC_DIR, folder_name)
        if not os.path.isdir(folder_path):
            continue

        files = os.listdir(folder_path)
        
        # 查找音频文件
        audio_file = None
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in audio_exts:
                audio_file = f
                break

        if not audio_file:
            continue

        # 查找封面文件
        cover_file = None
        for f in files:
            if f.lower() in ('cover.jpg', 'cover.png', 'cover.jpeg', 'cover.webp'):
                cover_file = f
                break

        # 查找歌词文件
        elrc_file = 'lyrics.elrc' if 'lyrics.elrc' in files else None
        lrc_file = 'lyrics.lrc' if 'lyrics.lrc' in files else None

        # 读取 metadata.json
        meta_path = os.path.join(folder_path, 'metadata.json')
        metadata = {}
        if os.path.exists(meta_path):
            try:
                with open(meta_path, 'r', encoding='utf-8') as mf:
                    metadata = json.load(mf)
            except Exception:
                pass

        # 解析歌手与歌名
        if '-' in folder_name:
            parts = folder_name.split('-', 1)
            default_artist = parts[0].strip()
            default_title = parts[1].strip()
        else:
            default_artist = '未知歌手'
            default_title = folder_name.strip()

        title = metadata.get('title') or default_title
        artist = metadata.get('artist') or default_artist
        album = metadata.get('album') or ''
        duration = metadata.get('duration') or 0
        match_score = metadata.get('matchScore') or 0
        has_word_level = metadata.get('hasWordLevel', bool(elrc_file))

        encoded_folder = urllib.parse.quote(folder_name)
        encoded_audio = urllib.parse.quote(audio_file)

        song_info = {
            'id': f"local_{hash(folder_name) & 0xffffffff}",
            'folder': folder_name,
            'title': title,
            'artist': artist,
            'album': album,
            'duration': duration,
            'audioUrl': f"/local_music/{encoded_folder}/{encoded_audio}",
            'coverUrl': f"/local_music/{encoded_folder}/{urllib.parse.quote(cover_file)}" if cover_file else '',
            'elrcUrl': f"/local_music/{encoded_folder}/lyrics.elrc" if elrc_file else '',
            'lrcUrl': f"/local_music/{encoded_folder}/lyrics.lrc" if lrc_file else '',
            'hasWordLevel': has_word_level,
            'matchScore': match_score,
            'source': metadata.get('source', 'local'),
            'updatedAt': os.path.getmtime(folder_path)
        }
        songs.append(song_info)

    return songs

import subprocess

# ── 语音转写解释器解析 ──────────────────────────────────────────────
# 切勿直接用裸 `python`：PATH 可能被沙箱/工具链覆盖，那个解释器往往没装 vosk，
# 导致 Level 2 语音转写在 Shazam 未命中时整级静默失效，退化成拿文件名假标题去搜索。
def _resolve_vosk_python():
    candidates = []
    if getattr(sys, 'executable', None):
        candidates.append([sys.executable])                     # 优先复用当前进程解释器
    py_launcher = shutil.which('py')
    if py_launcher:
        for ver in ('-3', '-3.14', '-3.13', '-3.12', '-3.11'):
            candidates.append([py_launcher, ver])                # Windows py 启动器找系统 Python
    for cand in candidates:
        try:
            r = subprocess.run(cand + ['-c', 'import vosk'], capture_output=True, text=True, timeout=15)
            if r.returncode == 0:
                return cand
        except Exception:
            continue
    return candidates[0] if candidates else ['py', '-3']

_PLACEHOLDER_TITLES = {'song', 'songs', 'unknown', 'untitled', 'undefined', 'null',
                       'audio', 'sample', 'recording', 'record', 'recorded', 'new', 'track',
                       '未知', '未知歌曲', '未知歌手', '未命名', '无标题', '无法识别', '无', '无歌名'}
# 录制临时文件拆分出的样本前缀（parseFilename 会把 sample_<时间戳>_<pid> 拆成 artist=sample）
_TEMP_ARTIST_TOKENS = {'sample', 'recording', 'record', 'recorded', 'rec', 'audio'}

def _is_placeholder_title(title, artist=''):
    s = str(title or '').strip().lower()
    if not s or len(s) <= 1:
        return True
    if s in _PLACEHOLDER_TITLES:
        return True
    # 形如 "1787312323456 82152" 这类"时间戳 + 进程号"的假标题（纯数字/空格数字）
    clean = re.sub(r'[\s,._-]', '', s)
    if re.fullmatch(r'\d{8,}', clean):
        return True
    # 形如 sample_123_456 这类录制的临时文件名，或拆分出的 artist=sample 前缀
    if re.match(r'^(sample_|rec_|recording_|obj_|record_|_temp_|temp_)', s):
        return True
    if str(artist or '').strip().lower() in _TEMP_ARTIST_TOKENS:
        return True
    return False

def recognize_audio_file(file_path):
    """
    多级智能识曲流水线：
    Level 1: Shazam 声学指纹识别 (Node.js)
    Level 2: Vosk 本地离线语音转写与歌词反查 (Python)
    Level 3: 音频内置 ID3 / Vorbis 标签与封面 (FFmpeg)
    Level 4: 智能文件名清洗
    """
    shazam_script = os.path.join(BASE_DIR, 'tools', 'shazam_recognize_json.js')
    vosk_script = os.path.join(BASE_DIR, 'tools', 'vosk_recognizer.py')

    # 1. Level 1: 尝试 Shazam 声学指纹
    shazam_res = None
    if os.path.exists(shazam_script):
        try:
            proc = subprocess.run(['node', shazam_script, file_path], capture_output=True, text=True, timeout=20)
            if proc.stdout:
                lines = proc.stdout.strip().split('\n')
                for line in reversed(lines):
                    try:
                        res = json.loads(line)
                        if isinstance(res, dict) and res.get('method') == 'shazam' and res.get('title'):
                            return res
                        if isinstance(res, dict) and ('title' in res or 'success' in res):
                            shazam_res = res
                    except Exception:
                        pass
        except Exception as e:
            print(f"[Shazam Recognize Error]: {e}")

    # 2. Level 2: 若 Shazam 未命中指纹，尝试 Vosk 本地离线语音识别与歌词反查
    vosk_fallback = None   # 即便歌词反查未匹配到曲目，也保留语音转写片段供在线按词反查
    if os.path.exists(vosk_script):
        try:
            vosk_py = _resolve_vosk_python()
            print(f"[Vosk] invoking {vosk_py[0]} with renderer={vosk_script.split(os.sep)[-1]} on {os.path.basename(file_path)}")
            proc_v = subprocess.run(vosk_py + [vosk_script, file_path], capture_output=True, text=True, timeout=45)
            if proc_v.stdout:
                lines_v = proc_v.stdout.strip().split('\n')
                for line in reversed(lines_v):
                    try:
                        res_v = json.loads(line)
                        if isinstance(res_v, dict) and res_v.get('success') and (res_v.get('title') or res_v.get('lyricSnippet')):
                            vosk_fallback = res_v
                            if res_v.get('title'):
                                print(f"[Vosk Match]: 成功通过歌词识别匹配歌曲: {res_v.get('artist')} - {res_v.get('title')}")
                                return res_v
                    except Exception:
                        pass
        except Exception as e:
            print(f"[Vosk Recognize Error]: {e}")

    # 3. Level 3 / Level 4: 回退到 ID3 标签、Vosk 歌词反查结果或文件名清洗结果
    #    优先返回语音转写出的歌词片段（即使未匹配到曲目），让前端能据歌词提示/反查
    if vosk_fallback:
        return vosk_fallback
    if shazam_res and not _is_placeholder_title(shazam_res.get('title'), shazam_res.get('artist')):
        return shazam_res
    if shazam_res and shazam_res.get('title'):
        # Shazam/ID3/文件名只给出占位或无意义标题（如 song、sample_xxx）→ 不当作命中，
        # 返回失败让前端提示"请录制更清晰的人声"，避免用假标题去搜索
        print(f"[Recognize] discarded placeholder title: {shazam_res.get('method')} / {shazam_res.get('title')!r} - {shazam_res.get('artist')!r}")
        return {'success': False, 'error': 'Shazam matched no track; silence or instrumental frame'}
    return {'success': False, 'error': 'Recognition failed'}

def handle_upload(data_dict):
    """
    处理音乐上传，并在服务端立即触发声学指纹听歌识曲
    data_dict: { filename, dataBase64 }
    """
    raw_name = data_dict.get('filename', 'uploaded_song.mp3')
    base64_data = data_dict.get('dataBase64', '')
    
    if not base64_data:
        raise ValueError("Missing dataBase64")

    # 去除可能的数据头 (data:audio/mp3;base64,...)
    if ',' in base64_data:
        base64_data = base64_data.split(',', 1)[1]

    binary_data = base64.b64decode(base64_data)
    
    # 提取拓展名
    ext = os.path.splitext(raw_name)[1].lower()
    if not ext:
        ext = '.mp3'

    base_stem = os.path.splitext(raw_name)[0]
    temp_folder_name = f"_temp_{sanitize_filename(base_stem)}_{int(os.path.getmtime(LOCAL_MUSIC_DIR)) if os.path.exists(LOCAL_MUSIC_DIR) else 1}"
    
    target_folder = os.path.join(LOCAL_MUSIC_DIR, temp_folder_name)
    os.makedirs(target_folder, exist_ok=True)

    dest_path = os.path.join(target_folder, f"song{ext}")
    with open(dest_path, 'wb') as f:
        f.write(binary_data)

    # 立即执行声学指纹与元数据识别
    recognition = recognize_audio_file(dest_path)

    return {
        'tempFolder': temp_folder_name,
        'filename': f"song{ext}",
        'originalName': raw_name,
        'size': len(binary_data),
        'shazam': recognition
    }

def handle_recognize_song(data_dict):
    """对已在 tempFolder 中的音频进行识曲"""
    temp_folder = data_dict.get('tempFolder')
    if not temp_folder:
        raise ValueError("Missing tempFolder")
    folder_path = os.path.join(LOCAL_MUSIC_DIR, temp_folder)
    if not os.path.exists(folder_path):
        raise ValueError("Folder not found")
    
    audio_file = None
    for f in os.listdir(folder_path):
        if os.path.splitext(f)[1].lower() in ('.mp3', '.flac', '.wav', '.m4a', '.ogg', '.aac'):
            audio_file = f
            break
    if not audio_file:
        raise ValueError("Audio file not found")
    
    dest_path = os.path.join(folder_path, audio_file)
    return recognize_audio_file(dest_path)

def handle_recognize_raw_audio(data_dict):
    """
    接收录音或上传音频的 Base64 数据并进行全流程识别（Shazam 声学指纹 -> Vosk 语音转写/歌词反查 -> ID3 标签）
    data_dict: { audioBase64: str, filename: str (可选) }
    """
    base64_data = data_dict.get('audioBase64') or data_dict.get('dataBase64') or ''
    filename = data_dict.get('filename', 'recorded_sample.webm')
    
    if not base64_data:
        raise ValueError("Missing audio data")

    if ',' in base64_data:
        base64_data = base64_data.split(',', 1)[1]

    binary_data = base64.b64decode(base64_data)
    
    ext = os.path.splitext(filename)[1].lower()
    if not ext:
        ext = '.webm'
    
    temp_dir = os.path.join(BASE_DIR, 'cache', 'recognize')
    os.makedirs(temp_dir, exist_ok=True)
    
    temp_file = os.path.join(temp_dir, f"sample_{int(time.time() * 1000)}_{os.getpid()}{ext}")
    try:
        with open(temp_file, 'wb') as f:
            f.write(binary_data)
        
        result = recognize_audio_file(temp_file)
        is_success = bool(result and (result.get('title') or result.get('success') is True))
        return {
            'success': is_success,
            'data': result if is_success else None,
            'raw': result
        }
    finally:
        try:
            if os.path.exists(temp_file):
                os.remove(temp_file)
        except Exception:
            pass

def handle_save_song(data_dict):
    """
    保存识别后的歌曲信息，规范化重命名文件夹
    data_dict: { tempFolder, title, artist, album, duration, coverUrl, coverBase64, elrcText, lrcText, matchScore, source }
    """
    temp_folder = data_dict.get('tempFolder')
    title = sanitize_filename(data_dict.get('title', '未知歌名'))
    artist = sanitize_filename(data_dict.get('artist', '未知歌手'))
    album = data_dict.get('album', '')
    duration = data_dict.get('duration', 0)
    elrc_text = data_dict.get('elrcText', '')
    lrc_text = data_dict.get('lrcText', '')
    match_score = data_dict.get('matchScore', 0)
    source = data_dict.get('source', 'local')

    source_path = os.path.join(LOCAL_MUSIC_DIR, temp_folder)
    if not os.path.exists(source_path):
        raise ValueError(f"Temp folder not found: {temp_folder}")

    # 规范目标文件夹名: 歌手 - 歌名
    final_folder_name = f"{artist} - {title}"
    target_path = os.path.join(LOCAL_MUSIC_DIR, final_folder_name)

    if source_path != target_path:
        if os.path.exists(target_path):
            # 若已存在同名歌曲文件夹，覆盖合并
            for item in os.listdir(source_path):
                s = os.path.join(source_path, item)
                d = os.path.join(target_path, item)
                if os.path.isfile(s):
                    shutil.copy2(s, d)
            shutil.rmtree(source_path, ignore_errors=True)
        else:
            os.rename(source_path, target_path)

    # 写入增强型歌词 lyrics.elrc
    if elrc_text:
        with open(os.path.join(target_path, 'lyrics.elrc'), 'w', encoding='utf-8') as f:
            f.write(elrc_text)

    # 写入标准逐行歌词 lyrics.lrc
    if lrc_text:
        with open(os.path.join(target_path, 'lyrics.lrc'), 'w', encoding='utf-8') as f:
            f.write(lrc_text)

    # 保存封面
    cover_base64 = data_dict.get('coverBase64')
    cover_url = data_dict.get('coverUrl')
    if cover_base64:
        if ',' in cover_base64:
            cover_base64 = cover_base64.split(',', 1)[1]
        try:
            with open(os.path.join(target_path, 'cover.jpg'), 'wb') as f:
                f.write(base64.b64decode(cover_base64))
        except Exception:
            pass
    elif cover_url and cover_url.startswith('http'):
        try:
            req = urllib.request.Request(cover_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=10) as resp:
                with open(os.path.join(target_path, 'cover.jpg'), 'wb') as f:
                    f.write(resp.read())
        except Exception as e:
            print(f"[Warning] Failed to download cover: {e}")

    # 写入 metadata.json
    metadata = {
        'title': data_dict.get('title', title),
        'artist': data_dict.get('artist', artist),
        'album': album,
        'duration': duration,
        'matchScore': match_score,
        'hasWordLevel': bool(elrc_text),
        'source': source
    }
    with open(os.path.join(target_path, 'metadata.json'), 'w', encoding='utf-8') as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    return {
        'success': True,
        'folder': final_folder_name
    }

def handle_delete_song(data_dict):
    """删除本地单曲目录（前端 /api/local-music/delete）。
    ★ 之前仅实现了 handle_delete_font，删除歌曲端点缺失 → 前端永远删不掉。"""
    folder = str(data_dict.get('folder') or data_dict.get('name') or '').strip()
    if not folder:
        return {'ok': False, 'err': '缺少文件夹名'}
    # 防御路径穿越：仅允许 LOCAL_MUSIC_DIR 下的直接子目录
    folder = os.path.basename(folder)
    target = os.path.join(LOCAL_MUSIC_DIR, folder)
    if not os.path.isdir(target):
        return {'ok': False, 'err': f'目录不存在: {folder}'}
    try:
        shutil.rmtree(target, ignore_errors=False)
    except Exception as e:
        return {'ok': False, 'err': str(e)}
    return {'ok': True, 'folder': folder}

def handle_upload_custom_lrc(data_dict):
    """用户手动为某首歌曲上传自定义歌词"""
    folder = data_dict.get('folder')
    lrc_text = data_dict.get('lrcText', '')
    is_elrc = data_dict.get('isEnhanced', False)

    if not folder:
        raise ValueError("Missing folder name")

    folder_path = os.path.join(LOCAL_MUSIC_DIR, folder)
    if not os.path.exists(folder_path):
        raise ValueError("Folder does not exist")

    filename = 'lyrics.elrc' if is_elrc else 'lyrics.lrc'
    with open(os.path.join(folder_path, filename), 'w', encoding='utf-8') as f:
        f.write(lrc_text)

    # 更新 metadata.json 中的标记
    meta_path = os.path.join(folder_path, 'metadata.json')
    metadata = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, 'r', encoding='utf-8') as mf:
                metadata = json.load(mf)
        except Exception:
            pass
    
    metadata['hasWordLevel'] = is_elrc
    metadata['source'] = 'custom_upload'
    with open(meta_path, 'w', encoding='utf-8') as mf:
        json.dump(metadata, mf, ensure_ascii=False, indent=2)

    return {'success': True}

    return {'success': True}

# ★ 字体目录迁至 web/src/font：list_local_fonts 生成的 url 是 /src/font/<名>，
#   静态服务以 web/ 为根——原先指向 <项目>/src/font 的文件 url 404，
#   前端文件夹扫描永远拿不到字体（拖进文件夹不生效的根因）。
FONT_DIR = os.path.join(BASE_DIR, 'web', 'src', 'font')
os.makedirs(FONT_DIR, exist_ok=True)

def list_local_fonts():
    """扫描 src/font 目录，返回所有本地字体文件列表"""
    fonts = []
    if not os.path.exists(FONT_DIR):
        return fonts
    valid_exts = {'.ttf', '.otf', '.woff', '.woff2'}
    for f in sorted(os.listdir(FONT_DIR)):
        ext = os.path.splitext(f)[1].lower()
        if ext in valid_exts:
            full_path = os.path.join(FONT_DIR, f)
            size = os.path.getsize(full_path)
            fonts.append({
                'fileName': f,
                'name': os.path.splitext(f)[0],
                'size': size,
                'url': f'/src/font/{urllib.parse.quote(f)}'
            })
    return fonts

def handle_save_font(data_dict):
    """保存上传的字体文件到 src/font 目录"""
    file_name = data_dict.get('fileName')
    base64_data = data_dict.get('data')
    if not file_name or not base64_data:
        raise ValueError("Missing fileName or data")
    
    clean_name = sanitize_filename(os.path.splitext(file_name)[0])
    ext = os.path.splitext(file_name)[1].lower()
    if ext not in {'.ttf', '.otf', '.woff', '.woff2'}:
        ext = '.ttf'
    final_name = f"{clean_name}{ext}"
    
    if ',' in base64_data:
        base64_data = base64_data.split(',', 1)[1]
    font_bytes = base64.b64decode(base64_data)
    
    target_file = os.path.join(FONT_DIR, final_name)
    with open(target_file, 'wb') as f:
        f.write(font_bytes)
        
    return {
        'success': True,
        'fileName': final_name,
        'url': f'/src/font/{urllib.parse.quote(final_name)}',
        'size': len(font_bytes)
    }

def handle_delete_font(data_dict):
    """从 src/font 目录删除字体文件"""
    file_name = data_dict.get('fileName')
    if not file_name:
        raise ValueError("Missing fileName")
    target_file = os.path.join(FONT_DIR, os.path.basename(file_name))
    if os.path.exists(target_file):
        os.remove(target_file)
    return {'success': True}

# ==================== 用户全量配置持久化 (user_config.json) ====================
USER_CONFIG_FILE = os.path.join(BASE_DIR, 'user_config.json')

def load_user_config():
    """读取本地 user_config.json 配置文件，若不存在则自动初始化创建"""
    if os.path.exists(USER_CONFIG_FILE):
        try:
            with open(USER_CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Config] 读取 user_config.json 失败: {e}")
    # 自动创建初始 user_config.json 模板
    init_data = {
        'settings': {},
        'playlists': [],
        'favorites': [],
        'eq': {},
        'performance': {},
        'lastUpdated': int(time.time() * 1000)
    }
    try:
        with open(USER_CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(init_data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Config] 初始化 user_config.json 失败: {e}")
    return init_data

def save_user_config(config_dict):
    """原子保存配置到本地 user_config.json 文件"""
    if not isinstance(config_dict, dict):
        raise ValueError("Config data must be a JSON object")
    
    tmp_file = f"{USER_CONFIG_FILE}.tmp"
    with open(tmp_file, 'w', encoding='utf-8') as f:
        json.dump(config_dict, f, ensure_ascii=False, indent=2)
    
    os.replace(tmp_file, USER_CONFIG_FILE)
    return {'success': True, 'savedAt': config_dict.get('lastUpdated')}

# ==================== 听歌识曲本地化缓存 (isrc -> 本地化歌名, 持久化到 recognize_cache.json) ====================
RECOGNIZE_CACHE_FILE = os.path.join(BASE_DIR, 'recognize_cache.json')

def load_recognize_cache():
    """读取本地 recognize_cache.json（isrc -> {title, artist, platform, id, ...}），不存在则返回空对象"""
    if os.path.exists(RECOGNIZE_CACHE_FILE):
        try:
            with open(RECOGNIZE_CACHE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    data.pop('recMeta', None)  # 仅存曲目映射，丢弃可能的元信息键
                    return data
        except Exception as e:
            print(f"[RecognizeCache] 读取 recognize_cache.json 失败: {e}")
    return {}

def save_recognize_cache(cache_dict):
    """原子保存 isrc 缓存到 recognize_cache.json"""
    if not isinstance(cache_dict, dict):
        raise ValueError("Recognize cache must be a JSON object")
    # 裁剪：仅保留 isrc 主键（形如 [A-Z]{2}[A-Z0-9]{8,}），其余键忽略
    cleaned = {k: v for k, v in cache_dict.items() if isinstance(v, dict)}
    tmp_file = f"{RECOGNIZE_CACHE_FILE}.tmp"
    with open(tmp_file, 'w', encoding='utf-8') as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)
    os.replace(tmp_file, RECOGNIZE_CACHE_FILE)
    return {'success': True, 'count': len(cleaned)}

# ==================== 在线音频临时短时缓存 (防 QQ 音乐 URL 失效 / 单曲轮转) ====================
AUDIO_CACHE_DIR = os.path.join(BASE_DIR, 'cache', 'audio')
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)
# 未晋升的 .tmp 残留超时（崩溃/中断下载留下的僵尸文件，超时直接清理）
AUDIO_TMP_STALE_HOURS = 1

def cleanup_audio_cache(keep_id=None):
    """清理 cache/audio/ 下的旧缓存：
    1) 僵尸 .tmp 残留（mtime 超过 AUDIO_TMP_STALE_HOURS 未晋升，服务崩溃/中断下载遗留）直接删；
    2) 删除所有非当前播放歌曲的缓存文件（含其 .tmp/.meta/.ok 伴生文件），
       保持「只留当前歌曲 + 正在下载的 .tmp」的轮转语义——单曲缓存天然有界，
       不会无限增长（旧版本残留的大文件正是由中断下载的僵尸 .tmp 造成）。
    keep_id: 当前歌曲 id，其同名文件（含伴生文件）一律保留。
    """
    if not os.path.exists(AUDIO_CACHE_DIR):
        return
    now = time.time()
    stale_sec = AUDIO_TMP_STALE_HOURS * 3600
    keep_prefix = str(keep_id) if keep_id else None
    for fname in os.listdir(AUDIO_CACHE_DIR):
        fpath = os.path.join(AUDIO_CACHE_DIR, fname)
        if not os.path.isfile(fpath):
            continue
        try:
            if fname.endswith('.tmp') and (now - os.path.getmtime(fpath)) > stale_sec:
                os.remove(fpath)
                print(f"[AudioCache] 清理僵尸 .tmp 残留: {fname}")
                continue
            if keep_prefix and fname.startswith(keep_prefix):
                continue
            os.remove(fpath)
        except Exception as e:
            print(f"[AudioCache] 删除旧缓存失败 {fname}: {e}")

def get_or_cache_audio_file(audio_url, song_id):
    """
    检查并缓存音频文件。若未缓存则从远程流式拉取并保存到 cache/audio/<song_id>.mp3
    同时自动清理之前其他歌曲的缓存文件
    """
    if not audio_url or not song_id:
        return None
        
    clean_id = sanitize_filename(str(song_id))
    cache_path = os.path.join(AUDIO_CACHE_DIR, f"{clean_id}.mp3")
    
    # 轮转清理：清理其他旧歌曲缓存
    cleanup_audio_cache(keep_id=clean_id)
    
    # 如果已存在且文件大小大于 10KB 则直接复用
    if os.path.exists(cache_path) and os.path.getsize(cache_path) > 10240:
        return cache_path

    # 从远程下载缓存（独立 .dl.tmp 命名，避免与 server.py 流式代理的 .tmp 互踩；
    # 晋升成功后写 .ok 哨兵，与流式代理的缓存校验机制保持一致）
    try:
        req = urllib.request.Request(audio_url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://y.qq.com/'
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status not in (200, 206):
                return None
            tmp_cache = cache_path + '.dl.tmp'
            with open(tmp_cache, 'wb') as f:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    f.write(chunk)
            if os.path.exists(tmp_cache) and os.path.getsize(tmp_cache) > 1024:
                os.replace(tmp_cache, cache_path)
                try:
                    with open(cache_path + '.ok', 'w') as f:
                        f.write(str(os.path.getsize(cache_path)))
                except Exception:
                    pass
                return cache_path
            else:
                if os.path.exists(tmp_cache):
                    try:
                        os.remove(tmp_cache)
                    except Exception:
                        pass
                return None
    except Exception as e:
        print(f"[AudioCache] 下载远程音频失败 ({song_id}): {e}")
        return None


