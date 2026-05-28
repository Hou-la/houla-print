$testZpl = '^XA^FO50,50^A0N,80,80^FDTEST HOULA^FS^FO50,150^A0N,40,40^FDMode RAW OK^FS^XZ'
$tmpFile = "$env:TEMP\zpl-test.bin"
[System.IO.File]::WriteAllText($tmpFile, $testZpl, [System.Text.Encoding]::ASCII)
Write-Host "ZPL file: $($testZpl.Length) chars"

$sig = @'
[DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)]
public static extern bool OpenPrinter(string n,out IntPtr h,IntPtr d);
[DllImport("winspool.drv",SetLastError=true)]
public static extern bool ClosePrinter(IntPtr h);
[DllImport("winspool.drv",CharSet=CharSet.Unicode,SetLastError=true)]
public static extern bool StartDocPrinter(IntPtr h,int l,ref DI d);
[DllImport("winspool.drv",SetLastError=true)]
public static extern bool EndDocPrinter(IntPtr h);
[DllImport("winspool.drv",SetLastError=true)]
public static extern bool StartPagePrinter(IntPtr h);
[DllImport("winspool.drv",SetLastError=true)]
public static extern bool EndPagePrinter(IntPtr h);
[DllImport("winspool.drv",SetLastError=true)]
public static extern bool WritePrinter(IntPtr h,IntPtr p,int c,out int w);
[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
public struct DI{public string pDocName;public string pOutputFile;public string pDatatype;}
'@
Add-Type -MemberDefinition $sig -Name RP4 -Namespace W32b -ErrorAction SilentlyContinue

$hp=[IntPtr]::Zero
$ok=[W32b.RP4]::OpenPrinter('Zebra105',[ref]$hp,[IntPtr]::Zero)
Write-Host "OpenPrinter: $ok (handle=$hp)"

$d=New-Object W32b.RP4+DI
$d.pDocName='ZPL Test'
$d.pDatatype='RAW'
$sd=[W32b.RP4]::StartDocPrinter($hp,1,[ref]$d)
Write-Host "StartDoc: $sd"
$sp=[W32b.RP4]::StartPagePrinter($hp)
Write-Host "StartPage: $sp"

$b=[System.IO.File]::ReadAllBytes($tmpFile)
Write-Host "Bytes to send: $($b.Length)"
$p=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
[System.Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length)
$w=0
$wr=[W32b.RP4]::WritePrinter($hp,$p,$b.Length,[ref]$w)
Write-Host "WritePrinter: ok=$wr, requested=$($b.Length), written=$w"
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($p)

[W32b.RP4]::EndPagePrinter($hp) | Out-Null
[W32b.RP4]::EndDocPrinter($hp) | Out-Null
[W32b.RP4]::ClosePrinter($hp) | Out-Null
Write-Host "DONE - Check if TEST HOULA printed on label"
