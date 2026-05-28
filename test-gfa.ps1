# Test 1: Small ^GFA graphic (10x10 black square)
# 10px wide = 2 bytes/row, 10 rows = 20 bytes total
# Row data: FF C0 (8 black + 2 black + 6 white)
$smallGfa = '^XA^FO50,50^GFA,20,20,2,FFC0FFC0FFC0FFC0FFC0FFC0FFC0FFC0FFC0FFC0^FS^FO50,80^A0N,30,30^FDSmall GFA OK^FS^XZ'

# Test 2: Medium ^GFA graphic (200x200 black box = 5000 bytes)
$bpr = [Math]::Ceiling(200/8)  # 25 bytes per row
$totalB = $bpr * 200           # 5000 bytes total
$rowHex = 'FF' * 25            # 25 bytes = 200 pixels all black (full row)
$allHex = $rowHex * 200        # 200 rows
$medGfa = "^XA^FO50,50^GFA,$totalB,$totalB,$bpr,$allHex^FS^FO50,280^A0N,30,30^FDMedium GFA OK^FS^XZ"

Write-Host "Test 1 (small): $($smallGfa.Length) chars"
Write-Host "Test 2 (medium): $($medGfa.Length) chars"

# Send test 1
$tmpFile = "$env:TEMP\zpl-gfa-test.bin"
[System.IO.File]::WriteAllText($tmpFile, $smallGfa, [System.Text.Encoding]::ASCII)

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
Add-Type -MemberDefinition $sig -Name RP5 -Namespace W32c -ErrorAction SilentlyContinue

function Send-ZPL($data, $label) {
    $f = "$env:TEMP\zpl-gfa-$label.bin"
    [System.IO.File]::WriteAllText($f, $data, [System.Text.Encoding]::ASCII)
    $hp=[IntPtr]::Zero
    [W32c.RP5]::OpenPrinter('Zebra105',[ref]$hp,[IntPtr]::Zero) | Out-Null
    $d=New-Object W32c.RP5+DI; $d.pDocName=$label; $d.pDatatype='RAW'
    [W32c.RP5]::StartDocPrinter($hp,1,[ref]$d) | Out-Null
    [W32c.RP5]::StartPagePrinter($hp) | Out-Null
    $b=[System.IO.File]::ReadAllBytes($f)
    $p=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($b.Length)
    [System.Runtime.InteropServices.Marshal]::Copy($b,0,$p,$b.Length)
    $w=0
    $r=[W32c.RP5]::WritePrinter($hp,$p,$b.Length,[ref]$w)
    Write-Host "$label : ok=$r sent=$($b.Length) written=$w"
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($p)
    [W32c.RP5]::EndPagePrinter($hp)|Out-Null
    [W32c.RP5]::EndDocPrinter($hp)|Out-Null
    [W32c.RP5]::ClosePrinter($hp)|Out-Null
}

Send-ZPL $smallGfa "small"
Start-Sleep -Seconds 3
Send-ZPL $medGfa "medium"
Write-Host "DONE - Check labels: small black square + medium black box"
