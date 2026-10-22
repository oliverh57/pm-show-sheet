# LTC prototype (risk R4)

Throwaway pure-Python decoders that showed LTC can be read from the example content. They need only `ffmpeg` on PATH.
The real app will use libltc from Rust instead.

```bash
# Decode 4s of LTC from channel 2 (index 1) starting at 10 minutes
ffmpeg -v error -ss 600 -t 4 -i "playback.wav" -af "pan=mono|c0=c1" -f s16le -ar 48000 - | python3 ltc_decode.py

# Scan a whole file every 10s and print TC jumps (song boundaries)
python3 ltc_scan.py "playback.wav" 1 10 5330
```

Limits: assumes 48 kHz and 25 fps (the long/short threshold is hard-coded to 18 samples in `ltc_scan.py`), ignores drop-frame and user bits, and doesn't validate TC ranges.
