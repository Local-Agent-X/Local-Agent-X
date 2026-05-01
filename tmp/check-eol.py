import pathlib
src = pathlib.Path("src/voice/tier4/kokoro-engine.ts").read_text(encoding="utf-8")
print("len chars:", len(src))
print("line count:", src.count("\n")+1)
print("CRLF count:", src.count("\r\n"))
print("LF only:", src.count("\n"))
