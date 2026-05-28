# Test ^GFA at 203 DPI (correct for MHT DT460B) 
# A 100x100 pixel box at 203 DPI = ~12.5mm square
$bpr = [Math]::Ceiling(100/8)  # 13 bytes per row
$totalB = $bpr * 100           # 1300 bytes total

# Build row: 12 full bytes (0xFF) + 1 byte with 4 bits set (0xF0)
$fullRow = ('FF' * 12) + 'F0'  # 100 pixels = 12*8 + 4 = exactly 100 bits, but padded to 13 bytes
$allHex = $fullRow * 100       # 100 rows

$zpl = "^XA^CI28^LH0,0^FO50,50^GFA,$totalB,$totalB,$bpr,$allHex^FS^FO50,170^A0N,30,30^FD203 DPI GFA OK^FS^XZ"

Write-Host "ZPL length: $($zpl.Length) chars, graphic: $totalB bytes"

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
Add-Type -MemberDefinition $sig -Name RP6 -Namespace W32d -ErrorAction SilentlyContinue

$f = "$env:TEMP\zpl-203test.bin"
[System.IO.File]::WriteAllText($f, $zpl, [System.Text.Encoding]::ASCII)
$hp=[IntPtr]::Zero
[W32d.RP6]::OpenPrinter('Zebra105',[ref]$hp,[IntPtr]::Zero) | Out-Null
$d=New-Object W32d.RP6+DI; $d.pDocName='203 DPI Test'; $d.pDatatype='RAW'
[W32d.RP6]::StartDocPrinter($hp,1,[ref]$d) | Out-Null
[W32d.RP6]::StartPagePrinter($hp) | Out-Null
$b=[System.IO.File]::ReadAllBytes($f)
$p=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
[System.Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length)
$w=0
$r=[W32d.RP6]::WritePrinter($hp,$p,$b.Length,[ref]$w)
Write-Host "WritePrinter: ok=$r sent=$($b.Length) written=$w"
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($p)
[W32d.RP6]::EndPagePrinter($hp)|Out-Null
[W32d.RP6]::EndDocPrinter($hp)|Out-Null
[W32d.RP6]::ClosePrinter($hp)|Out-Null

# Also try TSPL to see if the printer speaks TSC language
Write-Host ""
Write-Host "--- Now testing TSPL ---"
$tspl = "SIZE 100 mm, 150 mm`r`nGAP 3 mm, 0 mm`r`nDIRECTION 1`r`nCLS`r`nTEXT 50,50,`"3`",0,1,1,`"TEST TSPL OK`"`r`nTEXT 50,100,`"3`",0,1,1,`"MHT DT460B`"`r`nPRINT 1`r`n"
$f2 = "$env:TEMP\tspl-test.bin"
[System.IO.File]::WriteAllText($f2, $tspl, [System.Text.Encoding]::ASCII)
$hp2=[IntPtr]::Zero
[W32d.RP6]::OpenPrinter('Zebra105',[ref]$hp2,[IntPtr]::Zero) | Out-Null
$d2=New-Object W32d.RP6+DI; $d2.pDocName='TSPL Test'; $d2.pDatatype='RAW'
[W32d.RP6]::StartDocPrinter($hp2,1,[ref]$d2) | Out-Null
[W32d.RP6]::StartPagePrinter($hp2) | Out-Null
$b2=[System.IO.File]::ReadAllBytes($f2)
$p2=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($b2.Length)
[System.Runtime.InteropServices.Marshal]::Copy($b2,0,$p2,$b2.Length)
$w2=0
$r2=[W32d.RP6]::WritePrinter($hp2,$p2,$b2.Length,[ref]$w2)
Write-Host "TSPL WritePrinter: ok=$r2 sent=$($b2.Length) written=$w2"
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($p2)
[W32d.RP6]::EndPagePrinter($hp2)|Out-Null
[W32d.RP6]::EndDocPrinter($hp2)|Out-Null
[W32d.RP6]::ClosePrinter($hp2)|Out-Null
Write-Host "DONE - Check labels for ZPL GFA square + TSPL text"
