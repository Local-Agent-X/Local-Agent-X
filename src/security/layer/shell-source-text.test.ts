// The command line bash parses out of the text the model sent: continuations
// joined, heredoc bodies out, and each body handed to what reads it.
import { describe, expect, it } from "vitest";
import { readSourceText } from "./shell-source-text.js";

describe("line continuations", () => {
  it("are joined outside single quotes and comments, as bash does", () => {
    expect(readSourceText("apt-get install -y \\\n  curl \\\r\n  m4").command).toBe("apt-get install -y   curl   m4");
    expect(readSourceText(`echo "a \\\nb"`).command).toBe(`echo "a b"`);
    expect(readSourceText("echo 'a \\\nb'").command).toBe("echo 'a \\\nb'");
    expect(readSourceText("# note \\\ncurl x").command).toBe("# note \\\ncurl x");
    expect(readSourceText("echo \\\\\ncurl x").command).toBe("echo \\\\\ncurl x");
  });
});

describe("heredocs", () => {
  it("drops a data body and keeps the operator and its redirect", () => {
    const r = readSourceText("cat <<'EOF' > soln.py\nimport requests\n(a, b) = f()\nEOF\npython3 soln.py");
    expect(r).toEqual({ command: "cat <<'EOF' > soln.py\npython3 soln.py", scripts: [] });
  });

  it("hands a body a shell reads back as a script", () => {
    for (const cmd of [
      "bash <<'EOF'\nls\nEOF", "sh -s <<EOF\nls\nEOF", "cat <<'EOF' | bash\nls\nEOF", "X=1 bash <<EOF\nls\nEOF",
      "<<EOF bash\nls\nEOF", "(bash <<EOF\nls\nEOF\n)", "$SHELL <<EOF\nls\nEOF", "sudo bash <<EOF\nls\nEOF",
    ]) {
      expect(readSourceText(cmd).scripts, cmd).toEqual(["ls"]);
    }
  });

  it("keeps a program an interpreter reads on the line, as one quoted word", () => {
    const r = readSourceText("python3 - <<'PY'\nprint('hi')\nPY");
    expect(r.scripts).toEqual([]);
    expect(r.command).toBe(`python3 - <<'PY' 'print("hi")'\n`);
  });

  it("keeps what an unquoted body expands, and nothing from a quoted one", () => {
    expect(readSourceText("cat <<EOF > a\nnow: $(date) `id`\nEOF").command).toBe("cat <<EOF $(date) `id` > a\n");
    expect(readSourceText("cat <<'EOF' > a\nnow: $(date)\nEOF").command).toBe("cat <<'EOF' > a\n");
  });

  it("strips tabs for <<-, reads several heredocs in order, and leaves here-strings alone", () => {
    expect(readSourceText("cat <<-EOF > a\n\tx\n\tEOF\nls").command).toBe("cat <<EOF > a\nls");
    const two = readSourceText("paste <<A <<B | bash\none\nA\ntwo\nB");
    expect(two.scripts).toEqual(["one", "two"]);
    expect(readSourceText(`cat <<< "$(date)"`).command).toBe(`cat <<< "$(date)"`);
  });

  it("does not read a heredoc where bash would not", () => {
    for (const cmd of [`echo "<<EOF"\nls`, "echo $((1 << 2))\nls", "(( x <<= 1 ))\nls", "echo x # <<EOF\nls"]) {
      expect(readSourceText(cmd).command, cmd).toBe(cmd);
    }
  });

  it("ends a body only at a line that is exactly the delimiter, like bash", () => {
    const r = readSourceText("cat <<EOF > a\nEOF \nstill body\nEOF\nnext");
    expect(r.command).toBe("cat <<EOF > a\nnext");
  });
});
