using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

internal static class Dev2FullscreenFixture
{
    private static readonly IntPtr DpiAwarenessContextPerMonitorV2 = new IntPtr(-4);
    private const string ExpectedText = "Harness preview";
    private static string statePath;
    private static Form form;
    private static TextBox input;
    private static Button button;
    private static Label status;
    private static bool dpiAwarenessSet;
    private static bool buttonClicked;
    private static int eventSequence;
    private static string lastEvent = "startup";

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetDpiForWindow(IntPtr window);

    private static string Escape(string value)
    {
        return (value ?? "").Replace("\\", "\\\\").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    private static void WriteState(string eventName)
    {
        if (form == null || form.IsDisposed || input == null || input.IsDisposed) return;
        lastEvent = eventName;
        eventSequence += 1;
        var primary = Screen.PrimaryScreen == null ? Rectangle.Empty : Screen.PrimaryScreen.Bounds;
        var lines = new[]
        {
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
            "topMost=" + form.TopMost,
            "borderless=" + (form.FormBorderStyle == FormBorderStyle.None),
            "showInTaskbar=" + form.ShowInTaskbar,
            "formActive=" + (Form.ActiveForm == form),
            "inputFocused=" + input.Focused,
            "buttonClicked=" + buttonClicked,
            "textLength=" + (input.Text ?? "").Length,
            "containsExpected=" + ((input.Text ?? "").IndexOf(ExpectedText, StringComparison.Ordinal) >= 0),
            "text=" + Escape(input.Text ?? ""),
        };
        try
        {
            File.WriteAllText(statePath, String.Join("\n", lines) + "\n", new UTF8Encoding(false));
        }
        catch
        {
        }
    }

    private static void LayoutControls()
    {
        if (form == null || input == null || button == null || status == null) return;
        int width = form.ClientSize.Width;
        int height = form.ClientSize.Height;
        int center = width / 2;
        button.Size = new Size(420, 100);
        button.Location = new Point(center - button.Width / 2, Math.Max(360, height / 2 - 120));
        input.Size = new Size(760, 70);
        input.Location = new Point(center - input.Width / 2, Math.Min(height - 260, button.Bottom + 70));
        status.Size = new Size(Math.Min(1100, width - 160), 60);
        status.Location = new Point((width - status.Width) / 2, input.Bottom + 36);
    }

    [STAThread]
    private static void Main(string[] args)
    {
        statePath = args.Length > 0 ? args[0] : Path.Combine(Path.GetTempPath(), "dev2-fullscreen-fixture-state.txt");
        dpiAwarenessSet = SetProcessDpiAwarenessContext(DpiAwarenessContextPerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        form = new Form
        {
            Text = "Computer Harness DEV2 Synthetic Fixture",
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual,
            TopMost = true,
            ShowInTaskbar = false,
            MinimizeBox = false,
            MaximizeBox = false,
            ControlBox = false,
            BackColor = Color.FromArgb(12, 25, 48),
        };
        Rectangle primary = Screen.PrimaryScreen.Bounds;
        form.Bounds = primary;

        var title = new Label
        {
            Text = "COMPUTER HARNESS DEV2 SYNTHETIC FIXTURE",
            ForeColor = Color.FromArgb(235, 245, 255),
            BackColor = Color.Transparent,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 30.0f, FontStyle.Bold),
            AutoSize = false,
            Size = new Size(Math.Max(600, primary.Width - 160), 90),
        };
        var instructions = new Label
        {
            Text = "SAFE TARGET ONLY  |  Synthetic screen owned by this validation probe",
            ForeColor = Color.FromArgb(170, 205, 235),
            BackColor = Color.Transparent,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 16.0f, FontStyle.Regular),
            AutoSize = false,
            Size = new Size(Math.Max(500, primary.Width - 160), 50),
        };
        button = new Button
        {
            Text = "HARNESS PREVIEW",
            Name = "HarnessPreviewButton",
            Font = new Font("Segoe UI", 20.0f, FontStyle.Bold),
            BackColor = Color.FromArgb(45, 150, 105),
            ForeColor = Color.White,
            UseVisualStyleBackColor = false,
            TabStop = true,
        };
        var inputLabel = new Label
        {
            Text = "SAFE SYNTHETIC INPUT FIELD",
            ForeColor = Color.FromArgb(170, 205, 235),
            BackColor = Color.Transparent,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 15.0f, FontStyle.Bold),
            AutoSize = false,
            Size = new Size(760, 45),
        };
        input = new TextBox
        {
            Name = "HarnessPreviewInput",
            Font = new Font("Consolas", 24.0f, FontStyle.Regular),
            BackColor = Color.White,
            ForeColor = Color.FromArgb(15, 25, 40),
            BorderStyle = BorderStyle.FixedSingle,
            Text = "",
        };
        status = new Label
        {
            Text = "Awaiting the bounded synthetic action",
            ForeColor = Color.FromArgb(255, 220, 150),
            BackColor = Color.Transparent,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 15.0f, FontStyle.Regular),
            AutoSize = false,
        };
        var footer = new Label
        {
            Text = "No private application, browser, clipboard, or user document is part of this screen.",
            ForeColor = Color.FromArgb(135, 170, 205),
            BackColor = Color.Transparent,
            TextAlign = ContentAlignment.MiddleCenter,
            Font = new Font("Segoe UI", 12.0f, FontStyle.Regular),
            AutoSize = false,
            Size = new Size(Math.Max(500, primary.Width - 160), 42),
        };

        form.Controls.Add(title);
        form.Controls.Add(instructions);
        form.Controls.Add(button);
        form.Controls.Add(inputLabel);
        form.Controls.Add(input);
        form.Controls.Add(status);
        form.Controls.Add(footer);
        title.Location = new Point((primary.Width - title.Width) / 2, 80);
        instructions.Location = new Point((primary.Width - instructions.Width) / 2, title.Bottom + 15);
        footer.Location = new Point((primary.Width - footer.Width) / 2, primary.Height - 100);

        form.Resize += (_sender, _args) =>
        {
            LayoutControls();
            WriteState("resize");
        };
        form.Activated += (_sender, _args) =>
        {
            WriteState("activated");
        };
        form.Deactivate += (_sender, _args) =>
        {
            WriteState("deactivated");
        };
        button.Click += (_sender, _args) =>
        {
            buttonClicked = true;
            status.Text = "HARNESS PREVIEW clicked; focus the safe input field and type Harness preview";
            WriteState("button_clicked");
        };
        input.TextChanged += (_sender, _args) =>
        {
            if (input.Text.IndexOf(ExpectedText, StringComparison.Ordinal) >= 0)
            {
                status.Text = "Synthetic input accepted";
            }
            WriteState("text_changed");
        };
        input.Enter += (_sender, _args) => WriteState("input_enter");
        input.KeyDown += (_sender, _args) => WriteState("key_down");
        input.KeyUp += (_sender, _args) => WriteState("key_up");
        form.Shown += (_sender, _args) =>
        {
            LayoutControls();
            form.TopMost = true;
            form.Activate();
            input.Focus();
            WriteState("shown");
        };

        Application.Run(form);
    }
}
