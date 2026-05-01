with open('src/voice/tier4/kokoro-engine.ts','rb') as f:
    data=f.read()
bom = bytes([0xef,0xbb,0xbf])
indices=[]
i=0
while True:
    j = data.find(bom, i)
    if j<0: break
    indices.append(j)
    i=j+1
print('BOM count:', len(indices))
print('positions:', indices)
