# Scan a file's LTC channel every STEP seconds; report TC and discontinuities.
import sys, subprocess, struct
path, chan, step, dur = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
SYNC = [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,1]
def decode(t):
    raw = subprocess.run(["ffmpeg","-v","error","-ss",str(t),"-t","0.5","-i",path,"-vn","-af",f"pan=mono|c0=c{chan}","-f","s16le","-ar","48000","-"],capture_output=True).stdout
    s = struct.unpack('<%dh' % (len(raw)//2), raw)
    if len(s) < 1000: return None
    dc = sum(s)/len(s); cross=[]; p=s[0]-dc
    for i in range(1,len(s)):
        v=s[i]-dc
        if (p<0)!=(v<0): cross.append(i)
        p=v
    iv=[b-a for a,b in zip(cross,cross[1:])]
    if len(iv)<100: return None
    bits=[];i=0
    while i<len(iv):
        if iv[i]>18: bits.append(0); i+=1
        elif i+1<len(iv) and iv[i+1]<=18: bits.append(1); i+=2
        else: i+=1
    for j in range(64,len(bits)-16):
        if bits[j:j+16]==SYNC:
            f=bits[j-64:j]; b=lambda st,n: sum(f[st+k]<<k for k in range(n))
            return (b(56,2)*10+b(48,4), b(40,3)*10+b(32,4), b(24,3)*10+b(16,4), b(8,2)*10+b(0,4))
    return None
def secs(tc): return tc[0]*3600+tc[1]*60+tc[2]+tc[3]/25
prev=None; t=0.0
while t < dur:
    tc=decode(t)
    label = "--:--:--:--" if tc is None else "%02d:%02d:%02d:%02d"%tc
    note=""
    if prev is not None:
        pt,ptc=prev
        if (tc is None)!=(ptc is None): note="  <-- LTC "+("lost" if tc is None else "resumes")
        elif tc and abs((secs(tc)-secs(ptc))-(t-pt))>1: note="  <-- JUMP"
    if note or int(t) % 300 == 0: print(f"{int(t)//60:3d}:{int(t)%60:02d}  {label}{note}")
    prev=(t,tc); t+=step
