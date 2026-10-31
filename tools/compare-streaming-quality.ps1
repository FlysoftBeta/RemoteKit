param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9_-]+$')][string]$Name, [int]$TenantIndex=0)
$ErrorActionPreference = 'Stop'
$caseRoot = Join-Path (Split-Path -Parent $PSScriptRoot) "develop/tmp/$Name"
$prefix = Join-Path $caseRoot "source-trace/$Name-$TenantIndex"
$sourceMetadata = Get-Content -LiteralPath "$prefix-source-reference.json" -Raw | ConvertFrom-Json
$decodedMetadata = Get-Content -LiteralPath "$prefix-decoded-reference.json" -Raw | ConvertFrom-Json
$sourceTimestamp = [int64]$sourceMetadata.marker.timestamp % 4294967296
if (!$decodedMetadata.marker -or $sourceMetadata.marker.frameId -ne $decodedMetadata.marker.frameId -or $sourceTimestamp -ne $decodedMetadata.marker.timestamp) {
  throw 'Source and decoded PNG do not have the same CRC-validated marker frame and timestamp'
}
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
public static class RemoteKitQualityCompare {
  public static double[] Compare(string sourcePath, string decodedPath) {
    using (var source = new Bitmap(sourcePath)) using (var decoded = new Bitmap(decodedPath)) {
      if (source.Width != decoded.Width || source.Height != decoded.Height) throw new ArgumentException("PNG dimensions differ");
      int x=24,y=128,width=Math.Min(1000,source.Width-48),height=Math.Min(260,source.Height-y);
      if(width<=0 || height<=0) throw new ArgumentException("PNG smaller than quality crop");
      double r=0,g=0,b=0,absolute=0;
      for(int yy=y; yy<y+height; ++yy) for(int xx=x; xx<x+width; ++xx) {
        var a=source.GetPixel(xx,yy); var z=decoded.GetPixel(xx,yy);
        double dr=a.R-z.R,dg=a.G-z.G,db=a.B-z.B;
        r+=dr*dr;g+=dg*dg;b+=db*db;absolute+=Math.Abs(dr)+Math.Abs(dg)+Math.Abs(db);
      }
      double count=width*height;
      return new double[]{(r+g+b)/(3*count),r/count,g/count,b/count,absolute/(3*count),x,y,width,height,source.Width,source.Height};
    }
  }
}
'@
$values = [RemoteKitQualityCompare]::Compare("$prefix-source-scene.png", "$prefix-decoded.png")
$result = @{
  kind='aligned-scene-rgb-quality'; marker=$decodedMetadata.marker; rtpTimestamp=$decodedMetadata.rtpTimestamp;
  sourceImage="$prefix-source-scene.png"; decodedImage="$prefix-decoded.png";
  crop=@{x=$values[5];y=$values[6];width=$values[7];height=$values[8]}; imageWidth=$values[9];imageHeight=$values[10];
  mseRgb=$values[0];mseRed=$values[1];mseGreen=$values[2];mseBlue=$values[3];meanAbsoluteRgbError=$values[4];
  psnrRgbDb=$(if($values[0] -gt 0){10*[Math]::Log10(65025/$values[0])}else{$null}); perfectlyEqual=($values[0] -eq 0);
  scope='Same source marker frame/timestamp; crop excludes DOM marker/input/capabilities overlays and includes text/fine lines. Final image after tail refresh, not a before/after tail benefit comparison.'
}
$json = ConvertTo-Json -InputObject $result -Depth 6
[IO.File]::WriteAllText((Join-Path $caseRoot "quality-$TenantIndex.json"), $json)
Write-Output $json
