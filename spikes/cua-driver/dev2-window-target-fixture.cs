using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class Dev2WindowTargetFixture
{
    private const string ExpectedText = "Window target typed";
    private static readonly IntPtr DpiAwarenessContextPerMonitorV2 = new IntPtr(-4);
    private static string statePath;
    private static string role;
    private static Form form;
    private static Button targetButton;
    private static TextBox targetInput;
    private static Label status;
    private static bool dpiAwarenessSet;
    private static int eventSequence;
    private static int clickCount;
    private static int keyCount;
    private static string lastEvent = "startup";
    private static string lastKey = "";

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
        if (String.IsNullOrWhiteSpace(statePath) || form == null || form.IsDisposed || targetInput == null || targetInput.IsDisposed)
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
            "clientWidth=" + form.ClientSize.Width,
            "clientHeight=" + form.ClientSize.Height,
            "formActive=" + (Form.ActiveForm == form),
            "inputFocused=" + targetInput.Focused,
            "buttonClicked=" + (clickCount > 0),
            "clickCount=" + clickCount,
            "keyCount=" + keyCount,
            "lastKey=" + Escape(lastKey),
            "textLength=" + (targetInput.Text ?? "").Length,
            "typedExpected=" + ((targetInput.Text ?? "").IndexOf(ExpectedText, StringComparison.Ordinal) >= 0),
            "text=" + Escape(targetInput.Text ?? ""),
        };
        try
        {
            File.WriteAllText(statePath, String.Join("\n", lines) + "\n", new UTF8Encoding(false));
        }
        catch
        {
            // The evaluator treats a missing/stale oracle as a failed proof.
        }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        statePath = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "dev2-window-target-state.txt");
        role = args.Length > 1 ? args[1] : "target";
        string title = args.Length > 2 ? args[2] : "DEV2 WINDOW TARGET FIXTURE";
        int x = args.Length > 3 ? ParseInt(args[3], 180) : 180;
        int y = args.Length > 4 ? ParseInt(args[4], 140) : 140;
        int width = args.Length > 5 ? ParseInt(args[5], 960) : 960;
        int height = args.Length > 6 ? ParseInt(args[6], 680) : 680;

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
            KeyPreview = true,
            BackColor = Color.FromArgb(19, 33, 56),
        };
        Label heading = new Label
        {
            AutoSize = false,
            Location = new Point(40, 25),
            Size = new Size(720, 45),
            Text = "DEV2 WINDOW TARGET CONTRACT | " + role,
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Color.White,
            BackColor = Color.FromArgb(19, 33, 56),
            Font = new Font("Segoe UI", 16.0f, FontStyle.Bold),
        };
        targetButton = new Button
        {
            AccessibleName = "WINDOW TARGET BUTTON",
            Name = "WindowTargetButton",
            Text = "WINDOW TARGET BUTTON",
            Location = new Point(80, 100),
            Size = new Size(330, 72),
            Font = new Font("Segoe UI", 14.0f, FontStyle.Bold),
            TabStop = true,
        };
        Label inputLabel = new Label
        {
            AccessibleName = "WINDOW TARGET INPUT LABEL",
            AutoSize = false,
            Location = new Point(80, 205),
            Size = new Size(500, 34),
            Text = "WINDOW TARGET INPUT",
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Color.FromArgb(190, 220, 245),
            BackColor = Color.FromArgb(19, 33, 56),
            Font = new Font("Segoe UI", 12.0f, FontStyle.Bold),
        };
        targetInput = new TextBox
        {
            AccessibleName = "WINDOW TARGET INPUT",
            Name = "WindowTargetInput",
            Location = new Point(80, 245),
            Size = new Size(620, 48),
            Font = new Font("Consolas", 18.0f, FontStyle.Regular),
        };
        status = new Label
        {
            AccessibleName = "WINDOW TARGET STATUS",
            AutoSize = false,
            Location = new Point(80, 330),
            Size = new Size(760, 80),
            Text = "Awaiting window-local actions",
            TextAlign = ContentAlignment.MiddleLeft,
            ForeColor = Color.FromArgb(255, 220, 150),
            BackColor = Color.FromArgb(19, 33, 56),
            Font = new Font("Segoe UI", 12.0f, FontStyle.Regular),
        };
        form.Controls.Add(heading);
        form.Controls.Add(targetButton);
        form.Controls.Add(inputLabel);
        form.Controls.Add(targetInput);
        form.Controls.Add(status);
        targetButton.Click += (_sender, _args) =>
        {
            clickCount += 1;
            status.Text = "Window-local button action accepted";
            WriteState("button_clicked");
        };
        targetInput.TextChanged += (_sender, _args) =>
        {
            if ((targetInput.Text ?? "").IndexOf(ExpectedText, StringComparison.Ordinal) >= 0)
            {
                status.Text = "Window-local text accepted";
            }
            WriteState("text_changed");
        };
        targetInput.KeyDown += (_sender, eventArgs) =>
        {
            lastKey = eventArgs.KeyCode.ToString();
            keyCount += 1;
            WriteState("input_key_down");
        };
        form.KeyDown += (_sender, eventArgs) =>
        {
            lastKey = eventArgs.KeyCode.ToString();
            keyCount += 1;
            status.Text = "Window-local key accepted: " + lastKey;
            WriteState("form_key_down");
        };
        form.Activated += (_sender, _args) => WriteState("activated");
        form.Deactivate += (_sender, _args) => WriteState("deactivated");
        form.Resize += (_sender, _args) => WriteState("resize");
        form.Move += (_sender, _args) => WriteState("move");
        form.Shown += (_sender, _args) =>
        {
            form.Activate();
            targetInput.Focus();
            WriteState("shown");
        };
        Application.Run(form);
    }
}
