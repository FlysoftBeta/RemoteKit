param(
  [Parameter(Mandatory=$true)][string]$SourceImage,
  [Parameter(Mandatory=$true)][string]$DecodedImage,
  [Parameter(Mandatory=$true)][string]$SourceMetadata,
  [Parameter(Mandatory=$true)][string]$DecodedMetadata,
  [Parameter(Mandatory=$true)][string]$Output
)
$ErrorActionPreference = 'Stop'
$sourceRecord = Get-Content -LiteralPath $SourceMetadata -Raw | ConvertFrom-Json
$decodedRecord = Get-Content -LiteralPath $DecodedMetadata -Raw | ConvertFrom-Json
$sourceTimestamp = [int64]$sourceRecord.marker.timestamp % 4294967296
if (!$decodedRecord.marker -or $sourceRecord.marker.frameId -ne $decodedRecord.marker.frameId -or $sourceTimestamp -ne $decodedRecord.marker.timestamp) {
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
$values = [RemoteKitQualityCompare]::Compare($SourceImage, $DecodedImage)
$result = @{
  kind='aligned-scene-rgb-quality'; marker=$decodedRecord.marker; rtpTimestamp=$decodedRecord.rtpTimestamp;
  sourceImage=$SourceImage; decodedImage=$DecodedImage;
  crop=@{x=$values[5];y=$values[6];width=$values[7];height=$values[8]}; imageWidth=$values[9];imageHeight=$values[10];
  mseRgb=$values[0];mseRed=$values[1];mseGreen=$values[2];mseBlue=$values[3];meanAbsoluteRgbError=$values[4];
  psnrRgbDb=$(if($values[0] -gt 0){10*[Math]::Log10(65025/$values[0])}else{$null}); perfectlyEqual=($values[0] -eq 0);
  scope='Same source marker frame/timestamp; crop excludes DOM marker/input/capabilities overlays and includes text/fine lines. Final image after tail refresh, not a before/after tail benefit comparison.'
}
$json = ConvertTo-Json -InputObject $result -Depth 6
[IO.File]::WriteAllText(([IO.Path]::GetFullPath($Output)), $json)
Write-Output $json
