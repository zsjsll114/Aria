#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vosk_recognizer.py — 基于 Vosk 本地离线语音转文字与歌词反查匹配器
支持离线中文/英文轻量模型识别音频歌词，并反查歌曲元数据与逐字歌词。
"""

import sys
import os
import json
import subprocess
import urllib.request
import urllib.parse
import zipfile

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 将模型存放在 ASCII 用户目录 (~/.cache/vosk/models/)，避免 Windows C++ 库对中文路径乱码
MODELS_DIR = os.path.join(os.path.expanduser('~'), '.cache', 'vosk', 'models')

# 推荐离线轻量模型
CN_MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip"
CN_MODEL_NAME = "vosk-model-small-cn-0.22"

def get_ffmpeg_path():
    """定位 ffmpeg 可执行文件"""
    node_ffmpeg = os.path.join(BASE_DIR, 'node_modules', '@ffmpeg-installer', 'win32-x64', 'ffmpeg.exe')
    if os.path.exists(node_ffmpeg):
        return node_ffmpeg
    return 'ffmpeg'

def ensure_vosk_model():
    """确保本地存在 Vosk 语音模型，不存在时自动引导或下载"""
    os.makedirs(MODELS_DIR, exist_ok=True)
    
    target_dir = os.path.join(MODELS_DIR, CN_MODEL_NAME)
    if os.path.exists(target_dir):
        return target_dir

    # 检查现有任何有效模型
    for item in os.listdir(MODELS_DIR):
        full_path = os.path.join(MODELS_DIR, item)
        if os.path.isdir(full_path) and ('vosk-model' in item or 'model' in item):
            return full_path
            
    # 下载轻量中文模型 (~42MB)
    zip_path = os.path.join(MODELS_DIR, f"{CN_MODEL_NAME}.zip")
    
    print(f"[Vosk] 本地未找到模型，正在自动下载轻量离线模型: {CN_MODEL_NAME}...", file=sys.stderr)
    try:
        urllib.request.urlretrieve(CN_MODEL_URL, zip_path)
        print(f"[Vosk] 模型下载完成，正在解压...", file=sys.stderr)
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(MODELS_DIR)
        if os.path.exists(zip_path):
            os.remove(zip_path)
        return target_dir
    except Exception as e:
        print(f"[Vosk] 模型自动下载失败: {e}", file=sys.stderr)
        return None

def transcribe_audio_snippet(audio_path, model_path, start_sec=20, duration_sec=50):
    """使用 Vosk 转写音频人声片段"""
    import vosk
    vosk.SetLogLevel(-1) # 静音底层日志

    if not os.path.exists(model_path):
        return {"text": "", "words": []}

    model = vosk.Model(model_path)
    rec = vosk.KaldiRecognizer(model, 16000)
    rec.SetWords(True)

    ffmpeg_bin = get_ffmpeg_path()
    cmd = [
        ffmpeg_bin,
        '-ss', str(start_sec),
        '-i', audio_path,
        '-t', str(duration_sec),
        '-ar', '16000',
        '-ac', '1',
        '-f', 's16le',
        '-'
    ]

    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f"[Vosk] 启动 FFmpeg 失败: {e}", file=sys.stderr)
        return {"text": "", "words": []}

    full_text = []
    all_words = []

    while True:
        data = proc.stdout.read(4000)
        if not data:
            break
        if rec.AcceptWaveform(data):
            res = json.loads(rec.Result())
            if res.get('text'):
                full_text.append(res['text'])
            if res.get('result'):
                for w in res['result']:
                    w['start'] += start_sec
                    w['end'] += start_sec
                    all_words.append(w)

    final_res = json.loads(rec.FinalResult())
    if final_res.get('text'):
        full_text.append(final_res['text'])
    if final_res.get('result'):
        for w in final_res['result']:
            w['start'] += start_sec
            w['end'] += start_sec
            all_words.append(w)

    combined_text = " ".join(full_text).strip()
    return {
        "text": combined_text,
        "words": all_words
    }

def search_song_by_lyrics(lyric_text):
    """根据转写的歌词关键词在网易云 / QQ 音乐中反查歌曲"""
    if not lyric_text:
        return None
        
    # 清洗歌词文本，选取核心词串（前 30 个字或 6 个词）
    search_query = lyric_text[:30].strip()
    if len(search_query) < 2:
        return None

    # 1. 检索网易云音乐
    try:
        url = f"https://api.vkeys.cn/v2/music/netease?word={urllib.parse.quote(search_query)}&num=5"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            if data.get('code') == 200 and data.get('data'):
                candidates = data['data'] if isinstance(data['data'], list) else [data['data']]
                if candidates and len(candidates) > 0:
                    best = candidates[0]
                    return {
                        "title": best.get('song', ''),
                        "artist": best.get('singer', ''),
                        "album": best.get('album', ''),
                        "coverUrl": best.get('cover', ''),
                        "id": str(best.get('id', '')),
                        "source": "netease"
                    }
    except Exception:
        pass

    # 2. 检索 QQ 音乐
    try:
        url = f"https://api.vkeys.cn/v2/music/tencent?word={urllib.parse.quote(search_query)}&num=5"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as response:
            data = json.loads(response.read().decode('utf-8'))
            if data.get('code') == 200 and data.get('data'):
                candidates = data['data'] if isinstance(data['data'], list) else [data['data']]
                if candidates and len(candidates) > 0:
                    best = candidates[0]
                    return {
                        "title": best.get('song', ''),
                        "artist": best.get('singer', ''),
                        "album": best.get('album', ''),
                        "coverUrl": best.get('cover', ''),
                        "id": str(best.get('id', '')),
                        "source": "tencent"
                    }
    except Exception:
        pass

    return None

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing audio file path"}))
        return

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(json.dumps({"success": False, "error": "Audio file does not exist"}))
        return

    model_path = ensure_vosk_model()
    if not model_path:
        print(json.dumps({"success": False, "error": "Vosk model not available"}))
        return

    # 进行语音转写
    trans_res = transcribe_audio_snippet(audio_path, model_path)
    lyric_text = trans_res.get('text', '')
    words = trans_res.get('words', [])

    if not lyric_text:
        print(json.dumps({"success": False, "error": "No speech detected in audio"}))
        return

    # 根据歌词反查歌曲
    match = search_song_by_lyrics(lyric_text)

    output = {
        "success": True,
        "method": "vosk",
        "lyricSnippet": lyric_text,
        "wordsCount": len(words),
        "title": match['title'] if match else "",
        "artist": match['artist'] if match else "",
        "album": match['album'] if match else "",
        "coverUrl": match['coverUrl'] if match else "",
        "songId": match['id'] if match else "",
        "source": match['source'] if match else "vosk_offline",
        "words": words
    }

    print(json.dumps(output, ensure_ascii=False))

if __name__ == '__main__':
    main()
