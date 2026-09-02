using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

internal static class ProbeWindow
{
    private static string statePath;
    private static RichTextBox editor;
    private static int eventSequence;
    private static int dragCount;
    private static string lastEvent = "startup";
    private static string lastKey = "";
    private static string lastModifiers = "";
    private static Point dragStart;
    private static bool mouseMovedSinceDown;

    private static string Escape(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private static int VisibleLineAt(int x, int y)
    {
        if (editor == null || editor.IsDisposed)
        {
            return -1;
        }
        try
        {
            return editor.GetLineFromCharIndex(editor.GetCharIndexFromPosition(new Point(x, y)));
        }
        catch
        {
            return -1;
        }
    }

    private static void WriteState(string eventName)
    {
        if (String.IsNullOrWhiteSpace(statePath) || editor == null || editor.IsDisposed)
        {
            return;
        }
        lastEvent = eventName;
        eventSequence += 1;
        var text = editor.Text ?? "";
        var longLineCount = text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
            .Count(line => line.StartsWith("scroll-line-", StringComparison.Ordinal));
        var lines = new[]
        {
            "event=" + Escape(lastEvent),
            "eventSequence=" + eventSequence,
            "focused=" + editor.Focused,
            "textLength=" + text.Length,
            // Keep the exact final value available to the external evaluator.
            // This file is outside the model context and is written only for
            // the isolated fixture; it avoids treating text length as proof.
            "text=" + Escape(text),
            "containsProbeText=" + (text.IndexOf("Computer-Harness probe EN | 中文输入", StringComparison.Ordinal) >= 0),
            "longLineCount=" + longLineCount,
            "selectionStart=" + editor.SelectionStart,
            "selectionLength=" + editor.SelectionLength,
            "firstVisibleLine=" + VisibleLineAt(2, 2),
            "lastVisibleLine=" + VisibleLineAt(2, Math.Max(2, editor.ClientSize.Height - 4)),
            "lastKey=" + Escape(lastKey),
            "lastModifiers=" + Escape(lastModifiers),
            "dragCount=" + dragCount,
        };
        try
        {
            File.WriteAllText(statePath, String.Join("\n", lines) + "\n", new UTF8Encoding(false));
        }
        catch
        {
            // A transient state-file failure must not terminate the GUI under test.
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        statePath = args.Length > 0 ? args[0] : null;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new Form
        {
            Text = "Computer Harness Probe Fixture",
            Width = 820,
            Height = 620,
            StartPosition = FormStartPosition.CenterScreen,
            MinimizeBox = false,
            MaximizeBox = false,
        };
        var label = new Label
        {
            Text = "Safe local fixture: click, type, key, scroll and drag are expected.",
            Dock = DockStyle.Top,
            Height = 30,
            Padding = new Padding(8, 7, 8, 4),
        };
        editor = new RichTextBox
        {
            Multiline = true,
            Dock = DockStyle.Fill,
            DetectUrls = false,
            ScrollBars = RichTextBoxScrollBars.Both,
            Font = new Font("Consolas", 12.0f),
            Text = "READY\r\n",
        };
        editor.TextChanged += (_sender, _args) => WriteState("text_changed");
        editor.KeyDown += (_sender, eventArgs) =>
        {
            lastKey = eventArgs.KeyCode.ToString();
            lastModifiers = eventArgs.Modifiers.ToString();
            WriteState("key_down");
        };
        editor.KeyUp += (_sender, eventArgs) =>
        {
            WriteState("key_up");
        };
        editor.MouseDown += (_sender, eventArgs) =>
        {
            dragStart = eventArgs.Location;
            mouseMovedSinceDown = false;
            WriteState("mouse_down");
        };
        editor.MouseMove += (_sender, eventArgs) =>
        {
            if (eventArgs.Button != MouseButtons.None &&
                (Math.Abs(eventArgs.X - dragStart.X) > 5 || Math.Abs(eventArgs.Y - dragStart.Y) > 5))
            {
                mouseMovedSinceDown = true;
                WriteState("mouse_move");
            }
        };
        editor.MouseUp += (_sender, _args) =>
        {
            if (mouseMovedSinceDown)
            {
                dragCount += 1;
            }
            WriteState("mouse_up");
        };
        editor.VScroll += (_sender, _args) => WriteState("v_scroll");
        form.Shown += (_sender, _args) =>
        {
            editor.Focus();
            WriteState("shown");
        };
        form.Controls.Add(editor);
        form.Controls.Add(label);
        Application.Run(form);
    }
}
