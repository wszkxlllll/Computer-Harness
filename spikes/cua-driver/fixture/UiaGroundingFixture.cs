using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

// Owned, deterministic fixture for the production UIA grounding probe.
// It writes only boolean oracle state; no user text or screenshot data.
internal static class UiaGroundingFixture
{
    private static string statePath;
    private static bool clicked;
    private static bool focused;

    private static void WriteState()
    {
        if (String.IsNullOrWhiteSpace(statePath)) return;
        var text = "clicked=" + clicked + "\nfocused=" + focused + "\n";
        try { File.WriteAllText(statePath, text, new UTF8Encoding(false)); } catch { }
    }

    [STAThread]
    private static void Main(string[] args)
    {
        statePath = args.Length > 0 ? args[0] : null;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new Form
        {
            Text = "COMPUTER HARNESS UIA GROUNDING FIXTURE",
            StartPosition = FormStartPosition.Manual,
            Bounds = new Rectangle(260, 180, 920, 620),
            MinimizeBox = false,
            MaximizeBox = false,
            ShowInTaskbar = false,
        };
        var enabledButton = new Button
        {
            AccessibleName = "GROUNDING ENABLED BUTTON",
            Text = "Enabled grounding button",
            Location = new Point(40, 50),
            Size = new Size(280, 42),
        };
        enabledButton.Click += (_sender, _args) => { clicked = true; WriteState(); };
        var disabledButton = new Button
        {
            AccessibleName = "GROUNDING DISABLED BUTTON",
            Text = "Disabled grounding button",
            Location = new Point(40, 110),
            Size = new Size(280, 42),
            Enabled = false,
        };
        var edit = new TextBox
        {
            AccessibleName = "GROUNDING EDIT",
            Location = new Point(40, 190),
            Size = new Size(360, 32),
            Text = "fixture input",
        };
        edit.Enter += (_sender, _args) => { focused = true; WriteState(); };
        var menu = new MenuStrip { Name = "GroundingMenu" };
        var disabledMenu = new ToolStripMenuItem("Disabled grounding menu")
        {
            AccessibleName = "GROUNDING DISABLED MENU",
            Enabled = false,
        };
        menu.Items.Add(disabledMenu);
        form.MainMenuStrip = menu;
        form.Controls.Add(enabledButton);
        form.Controls.Add(disabledButton);
        form.Controls.Add(edit);
        form.Controls.Add(menu);
        form.Shown += (_sender, _args) => { edit.Focus(); WriteState(); };
        Application.Run(form);
    }
}
