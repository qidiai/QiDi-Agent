#!/usr/bin/env python3
"""本地 OCR 脚本 - 读取图片路径，输出识别文字"""
import sys
import os

def main():
    if len(sys.argv) < 2:
        print("用法: ocr.py <图片路径> [--json]", file=sys.stderr)
        sys.exit(1)

    image_path = sys.argv[1]
    use_json = len(sys.argv) > 2 and sys.argv[2] == "--json"

    if not os.path.exists(image_path):
        print(f"文件不存在: {image_path}", file=sys.stderr)
        sys.exit(1)

    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    result, _ = engine(image_path)

    if not result:
        if use_json:
            print('{"text":"","lines":[]}')
        else:
            print("(未识别到文字)")
        return

    lines = [item[1] for item in result]
    text = "\n".join(lines)

    if use_json:
        import json
        print(json.dumps({"text": text, "lines": lines}, ensure_ascii=False))
    else:
        print(text)


if __name__ == "__main__":
    main()
