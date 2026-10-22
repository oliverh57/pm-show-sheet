# Minimal LTC (SMPTE 12M biphase-mark) decoder: reads s16le mono @48k from stdin.
import sys, struct
SR = 48000
data = sys.stdin.buffer.read()
s = struct.unpack('<%dh' % (len(data)//2), data)
dc = sum(s)/len(s)
cross = []
prev = s[0] - dc
for i in range(1, len(s)):
    v = s[i] - dc
    if (prev < 0) != (v < 0):
        cross.append(i)
    prev = v
iv = [b - a for a, b in zip(cross, cross[1:])]
if not iv: print("no signal"); sys.exit()
# long interval = one bit period ('0'), two short = '1'
srt = sorted(iv); long_ = srt[int(len(srt)*0.9)]
thr = long_ * 0.75
bits = []; i = 0
while i < len(iv):
    if iv[i] > thr: bits.append(0); i += 1
    elif i+1 < len(iv) and iv[i+1] <= thr: bits.append(1); i += 2
    else: i += 1
SYNC = [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,1]
def bcd(b, start, n): return sum(b[start+k] << k for k in range(n))
frames = []
for j in range(64, len(bits)-16):
    if bits[j:j+16] == SYNC and j >= 64:
        f = bits[j-64:j]
        tc = (bcd(f,56,2)*10+bcd(f,48,4), bcd(f,40,3)*10+bcd(f,32,4), bcd(f,24,3)*10+bcd(f,16,4), bcd(f,8,2)*10+bcd(f,0,4), f[10])
        frames.append((j, tc))
bitrate = SR/long_
print(f"bit period ~{long_} samples -> ~{bitrate:.0f} bit/s -> ~{bitrate/80:.2f} fps; frames decoded: {len(frames)}")
for _, (h,m,sec,fr,df) in frames[:3] + frames[-2:]:
    print(f"  {h:02d}:{m:02d}:{sec:02d}{';' if df else ':'}{fr:02d}")
mx = max((tc[3] for _, tc in frames), default=None); print("  max frame number seen:", mx)
