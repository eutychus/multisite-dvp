<?php

$maindoc = (empty($_SERVER['HTTP_REFERER']) ? 'index.html' : basename($_SERVER['HTTP_REFERER']));
$js = "offline.js";

$files = array(
    $maindoc, $js, "hls.js", "bg-header-mobile.jpg", "logo_without_glow.svg", "pure-min.css", "https://ajax.googleapis.com/ajax/libs/jquery/2.2.2/jquery.min.js"
);
$lastModified = filemtime("cachemanifest.php");

for($i = 0; $i < count($files); $i++) {
	if(substr($files[$i], 0, 4) !== "http") $lastModified = max($lastModified, filemtime($files[$i]));
}

$manifest = "CACHE MANIFEST\n# Last-Modified :" . date('r') . "\nCACHE:\n" . implode("\n", $files) . "\n\nNETWORK:\n*\n";


$etag = md5($lastModified . " " . implode(" ", $files));

//header("Content-Type: text/cache-manifest");
header("Content-Type: text/plain");
header("Last-Modified: ".gmdate("D, d M Y H:i:s", $lastModified)." GMT");
header("Etag: $etag");
// header("Cache-Control: max-age=" . (60*30)); // cache control max age 30 minutes... php normally sets this to 0

$etagHeader=(isset($_SERVER['HTTP_IF_NONE_MATCH']) ? trim($_SERVER['HTTP_IF_NONE_MATCH']) : false);

if (@strtotime($_SERVER['HTTP_IF_MODIFIED_SINCE'])==$lastModified || $etagHeader == $etag)
{
    header('HTTP/1.0 304 Not Modified');
    exit;
}

echo $manifest;

?>
