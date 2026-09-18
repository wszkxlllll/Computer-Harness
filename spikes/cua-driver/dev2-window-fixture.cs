using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class Dev2WindowFixture
{
    private static readonly IntPtr DpiAwarenessContextPerMonitorV2 = new IntPtr(-4);
    private static string statePath;
    private static string role;
    private static Form form;
    private static bool dpiAwarenessSet;
    private static int eventSequence;
    private static string lastEvent = "startup";

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetDpiForWindow(IntPtr window);

    private static int ParseInt(string value, int fallback)
    {
        int parsed;
        return Int32.TryParse(value, out parsed) ? parsed : fallback;
    }

    private static string Escape(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private static void WriteState(string eventName)
    {
        if (String.IsNullOrWhiteSpace(statePath) || form == null || form.IsDisposed)
        {
            return;
        }
        lastEvent = eventName;
        eventSequence += 1;
        Rectangle primary = Screen.PrimaryScreen == null ? Rectangle.Empty : Screen.PrimaryScreen.Bounds;
        string[] lines =
        {
            "role=" + Escape(role),
            "event=" + Escape(lastEvent),
            "eventSequence=" + eventSequence,
            "dpiAwarenessSet=" + dpiAwarenessSet,
            "dpi=" + GetDpiForWindow(form.Handle),
            "primaryX=" + primary.X,
            "primaryY=" + primary.Y,
            "primaryWidth=" + primary.Width,
            "primaryHeight=" + primary.Height,
            "windowX=" + form.Bounds.X,
            "windowY=" + form.Bounds.Y,
            "windowWidth=" + form.Bounds.Width,
            "windowHeight=" + form.Bounds.Height,
            "formActive=" + (Form.ActiveForm == form),
            "topMost=" + form.TopMost,
            "borderless=" + (form.FormBorderStyle == FormBorderStyle.None),
        };
        try
        {
            File.WriteAllText(statePath, String.Join("\n", lines) + "\n", new UTF8Encoding(false));
        }
        catch
        {
            // The evaluator treats a missing/stale state file as a failed proof.
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        statePath = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "dev2-window-fixture-state.txt");
        role = args.Length > 1 ? args[1] : "target";
        string title = args.Length > 2 ? args[2] : "DEV2 WINDOW CONTRACT FIXTURE";
        int x = args.Length > 3 ? ParseInt(args[3], 160) : 160;
        int y = args.Length > 4 ? ParseInt(args[4], 120) : 120;
        int width = args.Length > 5 ? ParseInt(args[5], 900) : 900;
        int height = args.Length > 6 ? ParseInt(args[6], 650) : 650;

        dpiAwarenessSet = SetProcessDpiAwarenessContext(DpiAwarenessContextPerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        form = new Form
        {
            Text = title,
            StartPosition = FormStartPosition.Manual,
            Bounds = new Rectangle(x, y, width, height),
            FormBorderStyle = FormBorderStyle.Sizable,
            TopMost = false,
            ShowInTaskbar = false,
            MinimizeBox = false,
            MaximizeBox = false,
            BackColor = Color.FromArgb(22, 34, 54),
        };
        Label label = new Label
        {
            Dock = DockStyle.Fill,
            Text = "DEV2 SYNTHETIC WINDOW\r\n" + role + "\r\n\r\nWindow-level capture contract fixture",
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.White,
            BackColor = Color.FromArgb(22, 34, 54),
            Font = new Font("Segoe UI", 18.0f, FontStyle.Bold),
        };
        form.Controls.Add(label);
        form.Activated += (_sender, _args) => WriteState("activated");
        form.Deactivate += (_sender, _args) => WriteState("deactivated");
        form.Resize += (_sender, _args) => WriteState("resize");
        form.Move += (_sender, _args) => WriteState("move");
        form.Shown += (_sender, _args) =>
        {
            form.Activate();
            WriteState("shown");
        };
        Application.Run(form);
    }
}
