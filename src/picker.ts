import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Native Windows file/folder picker (the modern Explorer-style IFileOpenDialog),
 * driven from PowerShell. The C# helper is compiled once and cached in the temp folder.
 */
const SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class NativePicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}

  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr hwnd);
    void SetFileTypes(uint c, IntPtr f);
    void SetFileTypeIndex(uint i);
    void GetFileTypeIndex(out uint i);
    void Advise(IntPtr p, out uint c);
    void Unadvise(uint c);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr filter);
    void GetResults(out IShellItemArray ppenum);
    void GetSelectedItems(out IShellItemArray ppsai);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attribs);
    void Compare(IShellItem psi, uint hint, out int order);
  }

  [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemArray {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
    void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
    void GetAttributes(int flags, uint mask, out uint attribs);
    void GetCount(out uint count);
    void GetItemAt(uint index, out IShellItem item);
    void EnumItems(out IntPtr ppenum);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, IntPtr pid);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);

  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_ALLOWMULTISELECT = 0x200,
             FOS_PATHMUSTEXIST = 0x800, FOS_FILEMUSTEXIST = 0x1000;
  const uint SIGDN_FILESYSPATH = 0x80058000;

  // A background process may not take focus on its own; borrow it from the
  // current foreground window (the browser the user just clicked in).
  static void ForceForeground(IntPtr hwnd) {
    uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    if (fgThread != me) AttachThreadInput(me, fgThread, true);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    if (fgThread != me) AttachThreadInput(me, fgThread, false);
  }

  public static string[] Pick(bool folder, bool multiple, string title, string initialDir) {
    var owner = new Form {
      TopMost = true, ShowInTaskbar = false, FormBorderStyle = FormBorderStyle.None,
      Opacity = 0, StartPosition = FormStartPosition.CenterScreen, Width = 1, Height = 1,
    };
    owner.Show();
    ForceForeground(owner.Handle);
    try {
      var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
      uint options;
      dialog.GetOptions(out options);
      options |= FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | (folder ? FOS_PICKFOLDERS : FOS_FILEMUSTEXIST);
      if (multiple) options |= FOS_ALLOWMULTISELECT;
      dialog.SetOptions(options);
      if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
      if (!string.IsNullOrEmpty(initialDir) && Directory.Exists(initialDir)) {
        var iid = typeof(IShellItem).GUID;
        IShellItem start;
        SHCreateItemFromParsingName(initialDir, IntPtr.Zero, ref iid, out start);
        dialog.SetFolder(start);
      }
      if (dialog.Show(owner.Handle) != 0) return new string[0]; // cancelled

      IShellItemArray results;
      dialog.GetResults(out results);
      uint count;
      results.GetCount(out count);
      var paths = new List<string>();
      for (uint i = 0; i < count; i++) {
        IShellItem item;
        results.GetItemAt(i, out item);
        string p;
        item.GetDisplayName(SIGDN_FILESYSPATH, out p);
        paths.Add(p);
      }
      return paths.ToArray();
    } finally {
      owner.Close();
    }
  }
}
`;

const DLL = path.join(
  os.tmpdir(),
  `phone-transfer-picker-${crypto.createHash('sha1').update(SOURCE).digest('hex').slice(0, 12)}.dll`,
);

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if (-not (Test-Path $env:PICKER_DLL)) {
  Add-Type -TypeDefinition $env:PICKER_SRC -ReferencedAssemblies System.Windows.Forms -OutputAssembly $env:PICKER_DLL -OutputType Library
}
Add-Type -Path $env:PICKER_DLL
foreach ($p in [NativePicker]::Pick($env:PICK_FOLDER -eq '1', $env:PICK_MULTI -eq '1', $env:PICK_TITLE, $env:PICK_INITIAL)) {
  [Console]::Out.WriteLine($p)
}
`;

export const canPick = process.platform === 'win32';

export interface PickOptions {
  folder: boolean;
  multiple?: boolean;
  title: string;
  initialDir?: string;
}

/** Opens the picker on this PC and resolves with the chosen paths (empty if cancelled). */
export function pickPaths(opts: PickOptions): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          PICKER_DLL: DLL,
          PICKER_SRC: SOURCE,
          PICK_FOLDER: opts.folder ? '1' : '0',
          PICK_MULTI: opts.multiple ? '1' : '0',
          PICK_TITLE: opts.title,
          PICK_INITIAL: opts.initialDir ?? '',
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          console.error('Picker failed:', stderr || err.message);
          reject(err);
        } else {
          resolve(stdout.split(/\r?\n/).filter(Boolean));
        }
      },
    );
  });
}
