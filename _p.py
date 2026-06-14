p="run_eval_node.js"
s=open(p,encoding="utf-8").read()
a="const input = (e.tier === 'clean') ? e.pdf : (e.img || e.pdf);"
b="const R = (f) => path.join(corpus, path.basename(f));\n    const input = R((e.tier === 'clean') ? e.pdf : (e.img || e.pdf));"
s=s.replace(a,b)
s=s.replace("fs.readFileSync(e.gt, 'utf8')","fs.readFileSync(R(e.gt), 'utf8')")
open(p,"w",encoding="utf-8",newline="\n").write(s)
print("R present:", "const R =" in s, "| R(e.gt) present:", "R(e.gt)" in s)