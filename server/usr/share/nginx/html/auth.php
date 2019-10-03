<?php
  
  if(!empty($_REQUEST['name']) && !empty($_REQUEST['addr'])) {
    if(!empty($_REQUEST['key'])) {
		die("AUTH OK");
    }
  }
  
  http_response_code(403);

?>