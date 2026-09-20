using System;
using System.Drawing;
using System.Windows.Forms;

// This fixture is deliberately inert. The UIA probe reads it but never sends
// input or invokes a control. It contains common WinForms roles so the probe
// can distinguish role/name/frame/state availability without user data.
internal static class UiaReadonlyFixture
{
    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var form = new Form
        {
            Text = "UIA READONLY FIXTURE",
            StartPosition = FormStartPosition.Manual,
            Bounds = new Rectangle(220, 160, 900, 620),
            MinimizeBox = false,
            MaximizeBox = false,
            ShowInTaskbar = false,
        };

        var title = new Label
        {
            AccessibleName = "UIA READONLY TITLE",
            Text = "UIA readonly fixture",
            Location = new Point(32, 24),
            AutoSize = true,
        };
        var textBox = new TextBox
        {
            AccessibleName = "UIA READONLY TEXT",
            Name = "ReadonlyText",
            Location = new Point(32, 76),
            Size = new Size(340, 30),
            ReadOnly = true,
            Text = "fixture-value",
        };
        var combo = new ComboBox
        {
            AccessibleName = "UIA READONLY COMBO",
            Name = "ReadonlyCombo",
            Location = new Point(32, 136),
            Size = new Size(340, 30),
            DropDownStyle = ComboBoxStyle.DropDownList,
        };
        combo.Items.AddRange(new object[] { "Option A", "Option B" });
        combo.SelectedIndex = 0;

        var check = new CheckBox
        {
            AccessibleName = "UIA READONLY CHECKBOX",
            Name = "ReadonlyCheck",
            Text = "Readonly check",
            Location = new Point(32, 196),
            AutoSize = true,
            Checked = true,
        };

        var menu = new MenuStrip { Name = "ReadonlyMenu" };
        var menuRoot = new ToolStripMenuItem("Readonly menu") { AccessibleName = "UIA READONLY MENU" };
        menuRoot.DropDownItems.Add(new ToolStripMenuItem("Readonly item") { AccessibleName = "UIA READONLY MENU ITEM" });
        menu.Items.Add(menuRoot);
        form.MainMenuStrip = menu;

        form.Controls.Add(title);
        form.Controls.Add(textBox);
        form.Controls.Add(combo);
        form.Controls.Add(check);
        form.Controls.Add(menu);
        Application.Run(form);
    }
}
