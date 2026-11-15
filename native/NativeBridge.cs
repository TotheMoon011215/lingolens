// NativeBridge —— Electron 够不到的原生能力：UIA 取词、截屏、光标位置。
// 用系统自带的 csc.exe 编译，不装 .NET SDK、不装 MSVC、不装 node-gyp。
// 协议：stdin 一行一条 JSON 命令，stdout 一行一条 JSON 结果。
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;

class NativeBridge
{
    static StreamWriter Out;

    [STAThread]
    static void Main()
    {
        try { SetProcessDPIAware(); } catch { }
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        Out.AutoFlush = true;

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim();
            if (line.Length == 0) continue;
            try { Handle(line); }
            catch (Exception e) { Write("{\"ok\":false,\"error\":" + J(e.Message) + "}"); }
        }
    }

    static void Handle(string line)
    {
        string cmd = GetString(line, "cmd");
        switch (cmd)
        {
            case "ping": Write("{\"ok\":true,\"pong\":1}"); break;
            case "selection": Write(Selection()); break;
            case "textAtPoint": Write(TextAtPoint(GetInt(line, "x"), GetInt(line, "y"))); break;
            case "selectAtPoint": Write(SelectAtPoint(GetInt(line, "x"), GetInt(line, "y"))); break;
            case "cursor": Write(Cursor()); break;
            case "foreground": Write(Foreground()); break;
            case "capture": Write(Capture(line)); break;
            default: Write("{\"ok\":false,\"error\":\"unknown cmd\"}"); break;
        }
    }

    // ---------- 选中文本：先 UIA，失败再模拟 Ctrl+C ----------
    static string Selection()
    {
        string t = UiaSelection();
        if (!string.IsNullOrEmpty(t)) return "{\"ok\":true,\"text\":" + J(t) + ",\"src\":\"uia\"}";

        t = CopySelection();
        if (!string.IsNullOrEmpty(t)) return "{\"ok\":true,\"text\":" + J(t) + ",\"src\":\"clipboard\"}";

        return "{\"ok\":false,\"error\":\"no selection\"}";
    }

    static string UiaSelection()
    {
        try
        {
            string t = TrySelection(AutomationElement.FocusedElement);
            if (!string.IsNullOrEmpty(t)) return t;
        }
        catch { }

        try
        {
            var p = System.Windows.Forms.Cursor.Position;
            string t = TrySelection(AutomationElement.FromPoint(new System.Windows.Point(p.X, p.Y)));
            if (!string.IsNullOrEmpty(t)) return t;
        }
        catch { }

        return "";
    }

    /** 从元素往上找 TextPattern，取第一个非空选区 */
    static string TrySelection(AutomationElement el)
    {
        for (int i = 0; i < 6 && el != null; i++)
        {
            try
            {
                object pat;
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out pat))
                {
                    var ranges = ((TextPattern)pat).GetSelection();
                    if (ranges != null && ranges.Length > 0)
                    {
                        string s = ranges[0].GetText(-1);
                        if (!string.IsNullOrEmpty(s) && s.Trim().Length > 0) return s;
                    }
                }
            }
            catch { }
            try { el = TreeWalker.ControlViewWalker.GetParent(el); } catch { break; }
        }
        return "";
    }

    static string CopySelection()
    {
        System.Windows.Forms.IDataObject backup = null;
        try { backup = System.Windows.Forms.Clipboard.GetDataObject(); } catch { }

        // 先放一个哨兵值：只有剪贴板内容真的变了，才说明 Ctrl+C 成功
        string marker = "LLSENTINEL" + Guid.NewGuid().ToString("N");
        try { System.Windows.Forms.Clipboard.SetText(marker); } catch { }

        string result = "";
        try
        {
            SendCtrlC();
            for (int i = 0; i < 30; i++)
            {
                System.Threading.Thread.Sleep(20);
                try
                {
                    if (System.Windows.Forms.Clipboard.ContainsText())
                    {
                        string s = System.Windows.Forms.Clipboard.GetText();
                        if (!string.IsNullOrEmpty(s) && s != marker) { result = s; break; }
                    }
                }
                catch { }
            }
        }
        catch { }

        try { if (backup != null) System.Windows.Forms.Clipboard.SetDataObject(backup, true); } catch { }
        return result;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    static void SendCtrlC()
    {
        keybd_event(0x11, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(15);
        keybd_event(0x43, 0, 0, UIntPtr.Zero);
        System.Threading.Thread.Sleep(25);
        keybd_event(0x43, 0, 2, UIntPtr.Zero);
        System.Threading.Thread.Sleep(10);
        keybd_event(0x11, 0, 2, UIntPtr.Zero);
    }

    // ---------- 诊断：在坐标处选中一个词，验证 UIA 文本链路 ----------
    static string SelectAtPoint(int x, int y)
    {
        try
        {
            var el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
            for (int i = 0; i < 6 && el != null; i++)
            {
                object pat;
                if (el.TryGetCurrentPattern(TextPattern.Pattern, out pat))
                {
                    var tp = (TextPattern)pat;
                    var range = tp.RangeFromPoint(new System.Windows.Point(x, y));
                    range.ExpandToEnclosingUnit(TextUnit.Word);
                    range.Select();
                    return "{\"ok\":true,\"word\":" + J(range.GetText(-1)) + "}";
                }
                el = TreeWalker.ControlViewWalker.GetParent(el);
            }
        }
        catch (Exception e) { return "{\"ok\":false,\"error\":" + J(e.Message) + "}"; }
        return "{\"ok\":false,\"error\":\"no text pattern\"}";
    }

    // ---------- 屏幕坐标下的词 ----------
    static string TextAtPoint(int x, int y)
    {
        var el = AutomationElement.FromPoint(new System.Windows.Point(x, y));
        for (int i = 0; i < 6 && el != null; i++)
        {
            object pat;
            if (el.TryGetCurrentPattern(TextPattern.Pattern, out pat))
            {
                var tp = (TextPattern)pat;
                try
                {
                    var range = tp.RangeFromPoint(new System.Windows.Point(x, y));
                    var wordRange = range.Clone();
                    wordRange.ExpandToEnclosingUnit(TextUnit.Word);
                    string word = wordRange.GetText(-1).Trim();
                    if (word.Length > 0)
                    {
                        var r = wordRange.GetBoundingRectangles();
                        double bx = 0, by = 0, bw = 0, bh = 0;
                        if (r != null && r.Length >= 4) { bx = r[0].X; by = r[0].Y; bw = r[0].Width; bh = r[0].Height; }
                        return "{\"ok\":true,\"word\":" + J(word) + ",\"rect\":[" +
                               ((int)bx) + "," + ((int)by) + "," + ((int)bw) + "," + ((int)bh) + "]}";
                    }
                }
                catch { }
            }
            el = TreeWalker.ControlViewWalker.GetParent(el);
        }
        return "{\"ok\":true,\"word\":\"\"}";
    }

    // ---------- 前台窗口 ----------
    static string Foreground()
    {
        IntPtr h = GetForegroundWindow();
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        return "{\"ok\":true,\"title\":" + J(sb.ToString()) + ",\"pid\":" + pid + "}";
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    // ---------- 光标 ----------
    static string Cursor()
    {
        var p = System.Windows.Forms.Cursor.Position;
        return "{\"ok\":true,\"x\":" + p.X + ",\"y\":" + p.Y + "}";
    }

    // ---------- 截屏 ----------
    [System.Runtime.InteropServices.DllImport("gdi32.dll")]
    static extern bool BitBlt(IntPtr hdcDest, int x, int y, int w, int h, IntPtr hdcSrc, int sx, int sy, uint rop);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern IntPtr GetDC(IntPtr hWnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    static string Capture(string line)
    {
        int x = GetInt(line, "x"), y = GetInt(line, "y");
        int w = GetInt(line, "w"), h = GetInt(line, "h");
        string outPath = GetString(line, "out");
        if (w <= 0 || h <= 0 || string.IsNullOrEmpty(outPath))
            return "{\"ok\":false,\"error\":\"bad rect\"}";

        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                IntPtr srcDc = GetDC(IntPtr.Zero);
                IntPtr dstDc = g.GetHdc();
                BitBlt(dstDc, 0, 0, w, h, srcDc, x, y, 0x00CC0020 | 0x40000000); // SRCCOPY | CAPTUREBLT
                g.ReleaseHdc(dstDc);
                ReleaseDC(IntPtr.Zero, srcDc);
            }
            bmp.Save(outPath, ImageFormat.Png);
        }
        return "{\"ok\":true,\"path\":" + J(outPath) + ",\"w\":" + w + ",\"h\":" + h + "}";
    }

    // ---------- 极简 JSON 工具（不引 System.Web.Extensions） ----------
    static void Write(string s) { Out.WriteLine(s); }

    static string J(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder("\"");
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }

    static string GetString(string json, string key)
    {
        string needle = "\"" + key + "\"";
        int i = json.IndexOf(needle, StringComparison.Ordinal);
        if (i < 0) return "";
        int c = json.IndexOf(':', i + needle.Length);
        if (c < 0) return "";
        int q1 = json.IndexOf('"', c + 1);
        if (q1 < 0) return "";
        var sb = new StringBuilder();
        for (int k = q1 + 1; k < json.Length; k++)
        {
            char ch = json[k];
            if (ch == '\\')
            {
                k++;
                if (k >= json.Length) break;
                char e = json[k];
                if (e == 'n') sb.Append('\n');
                else if (e == 't') sb.Append('\t');
                else if (e == 'r') sb.Append('\r');
                else if (e == 'u' && k + 4 < json.Length)
                {
                    sb.Append((char)Convert.ToInt32(json.Substring(k + 1, 4), 16));
                    k += 4;
                }
                else sb.Append(e);
            }
            else if (ch == '"') break;
            else sb.Append(ch);
        }
        return sb.ToString();
    }

    static int GetInt(string json, string key)
    {
        string needle = "\"" + key + "\"";
        int i = json.IndexOf(needle, StringComparison.Ordinal);
        if (i < 0) return 0;
        int c = json.IndexOf(':', i + needle.Length);
        if (c < 0) return 0;
        int start = c + 1;
        while (start < json.Length && (json[start] == ' ' || json[start] == '\t')) start++;
        int end = start;
        while (end < json.Length && (char.IsDigit(json[end]) || json[end] == '-')) end++;
        int v;
        return int.TryParse(json.Substring(start, end - start), out v) ? v : 0;
    }

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();
}
