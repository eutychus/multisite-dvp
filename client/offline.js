// Handle vendor prefixes.
window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;
var hls = false;
var filesystem = null;
var fileSystemSize = 0;
var fileSystemUsed = 0;
var parsed_m3u8 = false;
var timer_m3u8 = false;
var playlist_url = ""; // http://clientname.dvp.lightcastmedia.com/dvp/clientname/index.m3u8
var remote_path = "";
var local_path = "";
var local_dir = ""; //
var loggedplaylist = true;
var MAX_AGE_SERVER = 6*60*60*1000; // server segments are kept no more than 6 hours (in ms)
var MAX_AGE_LOCAL = 14*24*60*60*1000; // local segments are kept no more than 14 days (in ms)
var multisequence = null; // used for a promise sequence for recording
var m3u8_signature = ''; // compare last 18 bytes of m3u8 to determine if new segments were added
var m3u8_last_update = 0; // ts (ms) of last time locally generated playlist was changed
var m3u8_last_cleanup = 0; // ts (ms) of last time locally generated playlist was changed
var m3u8_last_ts = 0; // last (most recent) ts processed
var m3u8_media_sequence = 1; // EXT-X-MEDIA-SEQUENCE... increment when segments are removed from the beginning with page already loaded
var m3u8_media_offset = 0.00; // Sum of all durations removed from sliding playlist. Used to calculate seek time
var m3u8_target_duration = 6; // derived from EXT-X-TARGETDURATION

var lastUncachedSegment = 0; // updated when player requests a segment that is not cached.  Used to cancel schedule downloads
var scheduleTimeout = 0; // used to recheck schedule
var cancelMulti = 0;

var cacheEnd = 0; // ts to stop recording... used to track 'record from here' when recording past end of storage area
var recordQueue = [];
var cached = {}; // Object with key of ts and value of size in bytes.  Used to check if a ts is cached and to count down size when cleaning up
var refreshTimeout = false; // m3u8 reloads every 5 seconds... allow clearing timeout to clear data
var config = {};
var error_workaround_time = 0;
var statusWindow = null;
var currentplaylist = false;
var recordings = {};
var schedule = [];
var days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var parent_domain = ".dvp.lightcastmedia.com";


function keyup(evt) {
	// disable if config form is visible
	if($("#configurationholder").is( ":visible" )) return false;
	if(document.activeElement.tagName === "INPUT") {
		if(evt.keyCode === 13) {
			get_seek_time($('#seek_to_broadcast_time').val());
			document.activeElement.blur();
		}
		return false;
	}

	// disable if a modifier key is pressed
	if(evt.ctrlKey || evt.altKey || evt.metaKey) {
		console.log("Modifier key held down, disabling action");
		return false;
	}

	var video = $("video").get(0);
	console.log(['keyup', evt.keyCode]);

	// enter or 'f' pressed, toggle full screen
	if(evt.keyCode === 13 || evt.keyCode === 70) {
		if(document.webkitFullscreenElement) {
			document.webkitExitFullscreen();
		}
		else {
			video.webkitRequestFullscreen(Element.ALLOW_KEYBOARD_INPUT);
		}
	}

	// space, keypad 5 (middle of arrows) with numlock off, keypad #5
	if(evt.keyCode === 32 || evt.keyCode === 12 || evt.keyCode === 101) {
		if(video.paused) video.play();
		else video.pause();
	}

	// r = 82, * = 106 (keypad, doesn't work with shift-8)
	if(evt.keyCode === 82 || evt.keyCode === 106) {
		recordFromPlayer();
	}

	// + = 107, 38 = up arrow
	if(evt.keyCode === 107 || evt.keyCode === 38) {
		video.currentTime += 600;
	}

	// minus = 109, dash = 189, 40 = down arrow
	if(evt.keyCode === 109 || evt.keyCode === 189 || evt.keyCode === 40) {
		video.currentTime -= 600;
	}

	// 39 = right arrow
	if(evt.keyCode === 39) {
		video.currentTime += 60;
	}

	// 37 = left arrow
	if(evt.keyCode === 37) {
		video.currentTime -= 60;
	}

	// 110 = key pad dot
	if(evt.keyCode === 110) {
		$("#seek_to_broadcast_time").focus();
	}

}

function statusWindowClosed() {
	statusWindow = null;
	$("#statusWindowButton").removeClass("selected");
}

function callStatusWindow(fname, arg1, arg2) {
	if(statusWindow) {
		try	{
			statusWindow[fname](arg1, arg2);
		}
		catch (err)	{ }
	}
}


//console.log(filesystem);

$(function() {
  // Handler for .ready() called.

  	$(window).on("unload", function() {
		if ((statusWindow != null) && (statusWindow.closed == false)) statusWindow.close();
	});


	$('video').bind('click webkitfullscreenchange fullscreenchange', function(e) {
		var state = document.fullScreen || document.mozFullScreen || document.webkitIsFullScreen;
		if(state && e.type === "click" && $('video').hasClass('hidecontrols')) state = false;

		if(state) {
			$('video').addClass('hidecontrols');
		}
		else {
			$('video').removeClass('hidecontrols');
		}

	});

	$('video').bind('timeupdate', function(e) {
		if(currentplaylist) {
			var eventtime = new Date(currentplaylist);

			var realts = currentplaylist + (e.target.currentTime*1000);

			// Assume around 1sec encoder delay
			// needs testing under multiple conditions to confirm
			realts -= 1000;

			// assume we drift behind by 900ms per hour
			// needs testing under multiple conditions to confirm
			//realts += ((e.target.currentTime/3600)*0.9*1000);

			var realtime = new Date(realts);
			//$("#timeholder").text(realtime.toString());
			$("#timeholder").text(realtime.toString().substring(0,3) + " " + realtime.toLocaleString());

			var hours = eventtime.getHours();
			var meridiem = "am";
			if(hours > 12) {
				hours -= 12;
				meridiem = "pm";
			}

			if(statusWindow) {
				var eventfmt = "Event: " + days[eventtime.getDay()] + ' ' + months[eventtime.getMonth()] + ' ' + eventtime.getDate() + ' ' + hours + ':' + pad(eventtime.getMinutes()) +  meridiem;
				var timefmt = pad(realtime.getHours()) + ':' + pad(realtime.getMinutes()) + ':' + pad(realtime.getSeconds())
				try	{
					statusWindow.timeUpdate(eventfmt, timefmt, video.currentTime, video.duration);
				}
				catch (err)	{ }
			}
		}

		else {
			// outside of sub playlist, can't calculate real time
			$("#timeholder").html("&nbsp;");
			if(statusWindow) {
				try	{
					statusWindow.timeUpdate("", "", video.currentTime, video.duration);
				}
				catch (err)	{ }
			}

		}


	});



	$("#menubar button").click(menubarToggle);
	var config = localStorage.getItem('offline-config');
	if(config) {
		console.log(config);
		config = JSON.parse(config);
		$("main").css("display", "inherit");

		var server_number = 1;
		var stream = config.domain;

		playlist_url = 'http://'+config.domain+server_number + parent_domain + "/dvp/"+stream+"/index.m3u8";
		remote_path = playlist_url.substring(0, playlist_url.lastIndexOf('/')+1);
		local_path = config.domain + "_" + server_number + "_" + stream;

		$('#config-domain').val(config.domain);
		$('#config-quota').val(config.quota/(1024*1024)); // form in bytes, store in mbytes
		$('#config-server-max-age').val(config.server_max_age/60000); // form in minutes, store in ms
		$('#config-local-max-age').val(config.local_max_age/(24*60*60*1000)); // form in days, store in ms

		initFileSystem();
	}
	else {
		// use window.location.href to get domain
		// format is: http://__DOMAIN____SERVERNO__.dvp.lightcastmedia.com/offline
		var wlh = window.location.href.split("/");
		var tmphost = wlh[2].split(".");
		if(tmphost.length > 1 && tmphost[1] === "dvp") $("#config-domain").val(tmphost[0].substring(0,tmphost[0].length-1));
		else $("#config-domain").val('demo1');

		$("#configurationholder").css("display", "inherit");
	}
});



function cleanupQuota(max) {
	// expects cached to be populated with metadata... from a previous async process
	// do not run immediately on page load
	navigator.webkitPersistentStorage.queryUsageAndQuota(function(used, quota) {
		// always keep around 75MB Free... that's 1 minute of video at 10mbit/s
		// we run the cleanup process every 15 seconds
		if(!max) max = quota - 75*1024*1024;
		//console.log(['quota:', quota, max, max - used]);
		if(used > max) {
			var deletedBytes = 0;
			console.log(["we need to cleanup", used, max]);

/*
			var segment_copy = Array.from(parsed_m3u8.entries());
			for(var i = 0; i < segment_copy.length; i++) {
				var ts = segment_copy[i][0];
				var duration = segment_copy[i][0];
*/
			for (var [ts, duration] of parsed_m3u8.entries()) {
				parsed_m3u8.delete(ts);
				$("#tsCache-"+ts).remove();

				callStatusWindow('removeElement', "#tsCache-"+ts);

				// increment m3u8_media_sequence when removing an entry from the top of the playlist
				// m3u8_media_sequence is reset to zero when a new m3u8 is started (recording/sub playlist)
				if(duration !== "DIS" && (currentplaylist === false || ts > currentplaylist)) {
					m3u8_media_sequence++;
					m3u8_media_offset += parseFloat(duration);
				}


				if(cached[ts]) {
					var size = cached[ts];
					console.log(["DEBUG", "Removed segment", ts, cached[ts], duration]);
					deletedBytes += size;
					used -= size;
					delete cached[ts];
					deleteFileByName(ts + '.ts');
				}
				else console.log(["DEBUG", "Removed uncached segment", ts, duration]);

				if(used < max) break;
			}
			m3u8_last_cleanup = new Date().getTime();
		}
		//else console.log(["no need to cleanup", used, max]);

		$("#diskusage").text(formatBytes(used,1) + ' / ' + formatBytes(quota,1));
		window.setTimeout(cleanupQuota, 15000, max);
	});
}

function listDirectory(tmppath) {
	if(!tmppath) tmppath = local_path;
	console.log(tmppath);
	filesystem.root.getDirectory(tmppath, {create:false}, function(directoryEntry) {
		listFiles(function(entries) {
			console.log(entries);

		}, directoryEntry);
	});

}

// Request a FileSystem and set the filesystem variable.
function initFileSystem() {
  var requestedBytes = 5*Math.pow(1024, 3); // 5GB Storage
  navigator.webkitPersistentStorage.requestQuota(requestedBytes,
    function(grantedSize) {
	  fileSystemSize = grantedSize;

	  navigator.webkitPersistentStorage.queryUsageAndQuota(function(used, quota) {
		$("#diskusage").text(formatBytes(used,1) + ' / ' + formatBytes(quota,1));
	  });

      // Request a file system with the new size.
      window.requestFileSystem(window.PERSISTENT, grantedSize, function(fs) {
		filesystem = fs;
		filesystem.root.getDirectory(local_path, {create:true}, function(directoryEntry) {

		loadFile("segments.json", function(val) {
			if(val.code) {
				console.log("error loading (" + local_path + "/segments.json)" + val.name);
				old_m3u8 = new Map();
			}
			else {
				console.log("loaded segments.json");
				if(val instanceof Array) old_m3u8 = new Map(val);
				else {
					console.log("segments.json not array, cannot convert to map");
					old_m3u8 = new Map();
				}
				val = undefined;
			}
			console.log('calling listfiles');
			set_broadcast_status("Checking storage");
			listFiles(function(entries) {
				set_broadcast_status("Loading...");
				console.log('return from listfiles');
				// for now, use the segment timestamp to handle initial cleanup.
				var currentTime = new Date().getTime();
				var cached = {};
				parsed_m3u8 = new Map();

				entries.forEach(function(entry, i) {
					var split = entry.name.split(".");
					if(split[1] == "ts") {
						cached[split[0]] = 1; // set initial size to 1 byte... this will later get updated by displayentry
					}
				});

				// [ segment_ts, segment_val (duration or DIS), cached, added_to_playlist ]
				var last = [0,"0",false,false];
				console.log('adding entries from cached m3u8, cleaning');
				for(var [seg, duration] of old_m3u8.entries()) {
					var current = [seg, duration, seg in cached, false];
					if(currentTime - current[0] < MAX_AGE_SERVER) {
						parsed_m3u8.set(current[0], current[1]);
						add_segment_block(current[0], current[1], current[2]);
					}
					else {
						//console.log([seg, 'more than 6 hours old', current[2]]);

						// delete old segment
						if(currentTime - current[0] > MAX_AGE_LOCAL) {
							// async, no sanity check or confirmation
							deleteFileByName(current[0] + '.ts');
						}

						// old segment, cached...
						else if(current[2]) {
							parsed_m3u8.set(current[0], current[1]);
							add_segment_block(current[0], current[1], current[2]);
							current[3] = true;
						}

						// old segment, uncached...
						// don't use it, regularly, but add a discontinuity if the last segment was cached
						else if(last[3]) {
							parsed_m3u8.set(current[0], "DIS");
							add_segment_block(current[0], "DIS", false);
						}
					}
					last = current;

					//console.log(current);
				}

				if(parsed_m3u8.size) m3u8_last_ts = last[0];

				//console.log(Object.keys(cached));

				refreshsegments();
				$("#menubar").css("display", "inline-block");
				$("#menubar button:first-of-type").click();

				//listFiles(displayEntries);
				showRecordings(listRecordings());
				var keys = Object.keys(recordings).sort();
				if(keys.length) {
					playRecording(parseInt(keys[keys.length-1],10));
				}
				else loadplayer();

				//window.setTimeout(cleanupQuota, 15000, 100*1024*1024);
				window.setTimeout(cleanupQuota, 15000);

			}, directoryEntry);
			});

		}, function() {
			// first time loading...
			console.log('first load / cache wiped');
			listFiles(displayEntries);
			refreshsegments();
			loadplayer();
			window.setTimeout(cleanupQuota, 15000, max);
		});
        //listFiles();
      }, errorHandler);

    }, errorHandler);
}

function debug_check_parsed_m3u8() {
	var times = Array.from(parsed_m3u8.keys());
	var good = true;
	for(var i = 1; i < times.length; i++) {
		if(typeof times[i] !== "number") console.log(["DEBUG", "NaN", times[i] ]);
		if(times[i] < times[i-1]) {
			console.log(["DEBUG", "Out of order", times[i-1], times[i] ]);
			good = false;
		}
	}
	console.log(['DEBUG', 'check_parsed_m3u8', good]);
}

function listFiles(callback, dirhandle) {
  if(!dirhandle) dirhandle = filesystem.root;
  var dirReader = dirhandle.createReader();
  var entries = [];
  var readentries_count = 0;

  var fetchEntries = function() {
	readentries_count++;
    dirReader.readEntries(function(results) {
	  console.log('readEntries length: ' + results.length);
      if (!results.length) {
		console.log('readEntries called ' + readentries_count + ' times');
        callback(entries.sort().reverse());
      } else {
        entries = entries.concat(results);
        fetchEntries();
      }
    }, errorHandler);
  };

  fetchEntries();
}

function displayEntries(entries) {
  entries.forEach(function(entry, i) {
	  displayEntry(entry);
  });
}

function displayEntry(entry) {
	// in no particular order, as getmetadata is async
	entry.getMetadata(function(md) {
		var split = entry.name.split(".");
		var tsint = 0;
		var segtime = "&nbsp;";
		var seglocal = "";

		if(split[1] == "ts") {
			cached[split[0]] = md.size;
			tsint = parseInt(split[0],10);
			seglocal = new Date(tsint).toLocaleString();
		}
		if(parsed_m3u8 && parsed_m3u8.has(tsint)) segtime = parseFloat(parsed_m3u8.get(tsint));
		//console.log([segtime, seglocal]);

/*
		// uncomment to populate files table
		var cells = [$("<td/>").text(entry.name), "<td>"+md.size+"</td>", "<td>"+seglocal+"</td>", "<td>"+md.modificationTime.toLocaleString()+"</td><td>"+segtime+"</td>"]

		if($("#dE-"+split[0]).length) {
			$("#dE-"+split[0]).empty().append(cells);
		}
		else {
			$("<tr />").attr('id', "dE-" + split[0]).append(cells).prependTo("#files-table > tbody");
		}
*/
//		if(/^[0-9]+$/.test(split[0])) {
		if(split[1] === "ts") {
			var ele = $("#tsCache-"+split[0]);
			if(ele.length) {
				ele.addClass("cached");
				if(statusWindow) {
					try	{ statusWindow.setClass("#tsCache-"+split[0], ele.attr('class')); }
					catch (err)	{ }
				}
			}
			else console.log("displayEntry, failed to mark cached: " + "#tsCache-"+split[0]);

		}
		//$("#files-table > tbody").append($("<tr/>").append($("<td/>").text(entry.name), "<td>"+md.size+"</td>", "<td>"+seglocal+"</td>", "<td>"+md.modificationTime.toLocaleString()+"</td>"));
  }, errorHandler);
}

function addSegmentToRecording(tsint, segtime) {
	if(typeof segtime === "number") {
		var keys = Object.keys(recordings).sort();
		if(keys.length) {
			var recording = parseInt(keys[keys.length-1]);
			if(tsint > recordings[recording] + (300*1000)) {
				recordings[tsint] = tsint;
				showRecording(tsint, segtime*1000);
			}
			else {
				recordings[recording] = tsint;
				$("#recording-"+recording+" td:nth-of-type(2)").text(formatDuration(tsint + (segtime*1000) - recording));
			}
		}
		else {
			recordings[tsint] = tsint;
			showRecording(tsint, segtime*1000);
		}

		// duration =
	}
	else console.log("segtime is not number: " + segtime);
}

function downloadRecording(recording_ts) {
	// recordings is an object (key value pair), with the key being the first segment of a recording
	// the value is the last segment.
	recording_ts = parseInt(recording_ts,10);
	var lastts = recordings[recording_ts];


	// first, we populate a list of segments
	// we cycle through the async list of segments with async calls... with the final part of the process for
	// one segment triggering the start of the next one.
	var segments = [];
	var currentSegment = -2;

	var fsWriter = false;

	var loadFileSuccess = function(arrBuf) {
		// TODO: save results
		console.log("Success loading segment: " + segments[currentSegment]);
		var contentBlob = new Blob([arrBuf], {type: 'video/mp2t'});

		fsWriter.write(contentBlob);
	}

	var loadFileFail = function() {
		console.log("Failure loading segment: " + segments[currentSegment]);
		currentSegment++;

		if(currentSegment >= segments.length) console.log("Finished loading segments");
		else loadFile(segments[currentSegment] + '.ts', loadFileSuccess, loadFileFail);
	}

	var errorHandler = function(e) {
		console.log("errorHandler called");
		console.log(e);
	}

	var saveData = (function () {
	    var a = document.createElement("a");
		a.style = "display: none";
	    document.body.appendChild(a);

		return function (url,fileName) {
	        a.href = url;
		    a.download = fileName;
	        a.click();
		};
	}());


	var openFsWriter = function(filename) {
		filesystem.root.getFile(local_path + "/" + filename, {create: true}, function(fileEntry) {
			console.log("getfile success");
			fileEntry.createWriter(function(fileWriter) {
				console.log("createWriter success");
				fsWriter = fileWriter;

				fileWriter.onwriteend = function(e) {
					console.log("fileWriter.onwriteend called");
					// loop -2 truncates
					// next loop starts on -1, and is incremented before loading
					// set to zero, it will match the available segments
					if(currentSegment == -2) {
						console.log("currentSegment is -2, truncate should be complete");
						currentSegment++;
					}

					if(currentSegment > -1) console.log("Finished writing segment " + segments[currentSegment]);
					currentSegment++;
					if(currentSegment < segments.length) loadFile(segments[currentSegment] + '.ts', loadFileSuccess, loadFileFail);
					else {
						console.log("Finished writing segments");
						console.log(fileEntry.toURL());
						saveData(fileEntry.toURL(), "recording.ts");

						// delete temporary file after a minute
						window.setTimeout('deleteFileByName("recording.ts");', 60000);
					}
				};

				fileWriter.onerror = function(e) {
					console.log('Write error: ' + e.toString());
					alert('An error occurred and your file could not be saved!');
				};

				fileWriter.truncate(0);
			}, errorHandler);
		}, errorHandler);
	}


	console.log(recordings[recording_ts]);
	for(var [ts, duration] of parsed_m3u8.entries()) {
		if(recording_ts && ts < recording_ts) continue;
		if(recording_ts && ts > lastts + (300*1000)) break;
		console.log([ts,duration]);

		if(parseFloat(duration)) {
			//blobs[ts] = 0;
			//loadFile(filename, loadBlobSuccess, loadBlobFail);
			segments.push(ts);
		}
	}
	openFsWriter("recording.ts");
	//loadFile(segments[currentSegment] + '.ts', loadFileSuccess, loadFileFail);



}

function deleteEntry(entry) {
	var filename = entry.name;
	var is_dir = false;
	var func = entry.remove;
	if(entry.removeRecursively) { func = entry.removeRecursively; is_dir = true; }
	console.log(func);

	func.call(entry, function() {
		var split = filename.split(".");
		if(is_dir) console.log('Dir removed: ' + filename);
		else console.log('File removed.');
		$("#dE-"+split[0]).remove();

	}, errorHandler);
}

function deleteFileByName(filename) {
	filesystem.root.getFile(local_path + "/" + filename, {create: false}, function(fileEntry) {
		fileEntry.remove(function() {
			var split = filename.split(".");
			console.log('File removed.');
			$("#dE-"+split[0]).remove();
		}, errorHandler);
	}, errorHandler);
}

function deleteAll() {
	$("#files-table > tbody > tr").each(function(index) {
		var id = $(this).attr('id').substring(3);
		var fname = id + (id === "segments" ? '.json' : '.ts');
		deleteFileByName(fname);
	});
}

function wipeCache() {
  clearTimeout(refreshTimeout);
  hls.detachMedia()
  $("#broadcast-status .txt").text("Clearing Storage");
  setTimeout(function() { location.reload(); return false; }, 5000)
  listFiles(function(entries) {
	  entries.forEach(function(entry, i) {
		  //deleteFileByName(entry.name);
		  deleteEntry(entry);
	  });
  });
  return false;
}

function saveFile(filename, content, success) {
  // sanity check
  if(!(content instanceof Blob) || content.size === 0) {
	  console.log('savefile ' + filename + 'failed sanity check');
	  if(success) success();
	  return false;
  }

  filesystem.root.getFile(local_path + "/" + filename, {create: true}, function(fileEntry) {
	var loopcount = 0;
    fileEntry.createWriter(function(fileWriter) {
      fileWriter.onwriteend = function(e) {
		if(loopcount === 0) { fileWriter.write(content); loopcount++; }
		else {
			// displayEntry also updates cached size
			displayEntry(fileEntry);
			if(success) success();
		}
      };

      fileWriter.onerror = function(e) {
        console.log('Write error: ' + e.toString());
        alert('An error occurred and your file could not be saved!');
      };

	  fileWriter.truncate(0);

    }, errorHandler);

  }, errorHandler);
}


function downloadFile(url, responsetype, success) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
	//xhr.setRequestHeader("Cache-Control", "no-cache");
	//xhr.setRequestHeader("Pragma", "no-cache");
    xhr.responseType = responsetype;
    xhr.onreadystatechange = function () {
        if (xhr.readyState == 4) {
            if (success) success(xhr.response);
        }
    };
    xhr.send(null);
}

function downloadFilePromise(obj) {
	return new Promise(function(resolve, reject) {
		if(obj.ts < cancelMulti && obj.urlcount > 1) {
			console.log(['canceling download', obj.url]);
			resolve(obj);
			return;
		}
		var filename = obj.url.split('/').pop();

		filesystem.root.getFile(local_path + "/" + filename, {"create": false}, function(fileEntry) {
			// file exists...
			//setTimeout(function() {	console.log(['downloadFilePromise: file eixsts', obj.url]); resolve(obj); }, 5000);
			console.log(['downloadFilePromise: file eixsts', obj.url]); resolve(obj);
		}, function(err) {
			// file missing, go ahead and download it...
			var xhr = new XMLHttpRequest();
			xhr.open('GET', obj.url, true);

			// we set expires on the web server to 1s to prevent caching
/*
			if(obj.noCache) {
				xhr.setRequestHeader("Cache-Control", "no-cache");
				xhr.setRequestHeader("Pragma", "no-cache");
			}
*/
			if(obj.responseType) {
				xhr.responseType = obj.responseType;
			}

			obj.xhr = xhr;

			xhr.onload = function (e) {
				if (this.status === 200) {
					saveFile(filename, xhr.response, function() {
						resolve(obj);
					});
					//resolve(obj);
				}
				else reject(obj);
			};

			xhr.onerror = function (e) {
				obj.error = e;
				def.reject(obj);
			};

			xhr.send();
		});
	});
}


function getMulti(url_array) {
	if(!multisequence) multisequence = Promise.resolve();

	function getClosure(url,i, urlcount) {
		function dl() {
			var obj = {
				'url': url,
				'noCache': true,
				'urlpos': i,
				'urlcount': urlcount,
				'responseType':'blob',
				'ts': new Date().getTime(),
				'success': function(obj) {
					console.log([obj.urlpos + '/' + obj.urlcount, obj.url]);
				}
			}

			return downloadFilePromise(obj);
		}
		return dl;
	}

	cancelMulti = 0;
	if(typeof url_array == "string") url_array = [url_array];
	console.log(['getMulti',url_array]);
	for(var i = 0; i < url_array.length; i++) {
		multisequence = multisequence.then(getClosure(url_array[i], i, url_array.length));
	}
}

function errorHandler(err) {
	console.log(err.name);
	console.log(err);
}

function loadFile(filename, success, error) {
  filesystem.root.getFile(local_path + "/" + filename, {}, function(fileEntry) {
    fileEntry.file(function(file) {
       var reader = new FileReader();

       reader.onloadend = function(e) {
		if(success) {
			var ret = this.result;
			if(filename.slice(-4) === "json") {
				try
				{
					ret = JSON.parse(this.result);
				}
				catch (err)
				{
					console.log("ERROR DECODING JSON: " + filename);
					console.log(this.result);
					ret = { };
				}
			}

			success(ret);
		}
	   };

	   if(filename.slice(-4) === "json") reader.readAsBinaryString(file);
	   else reader.readAsArrayBuffer(file);
    }, (error || errorHandler));

  }, success);
}





var fragmentLoader = function() {

  /* calling load() will start retrieving content at given URL (HTTP GET)

  See: https://github.com/dailymotion/hls.js/blob/master/API.md
  */
  this.load = function(context,config,callbacks) {
	var url = context.url
	var fname = url.split('/').pop();
	var fragts = fname.split(".").shift();
	var frag = $("#tsCache-"+fragts);
	var sStats = {
		trequest: performance.now(),
		tfirst: performance.now()
	};

		loadFile(fname, function(arrBuf) {
			if(arrBuf.name && arrBuf.name === "NotFoundError") {

				// player request uncached fragment, cancel any existing scheduler downloads
				cancelMulti = new Date().getTime();

				//console.log("cache miss: " + fname);
				downloadFile(url, "blob", function(blob) {
					sStats.tfirst = performance.now();
					saveFile(fname, blob, function() {
						loadFile(fname, function(arrBuf) {
							$("#ts_segments > span.playing").removeClass("playing");
							frag.addClass("playing");
							callStatusWindow('setPlaying', fragts);

//							onSuccess({currentTarget: { response: arrBuf }}, {});
							var sResponse = {
								url: url,
								data: arrBuf
							}

							sStats.tload = performance.now();
							sStats.loaded = arrBuf.byteLength;
							sStats.total = arrBuf.byteLength;

							callbacks.onSuccess(sResponse, sStats, context);

						});
					});
				});

			}
			else {
				$("#ts_segments > span.playing").removeClass("playing");
				frag.addClass("playing");
				callStatusWindow('setPlaying', fragts);

				var sResponse = {
					url: url,
					data: arrBuf
				}

				sStats.tload = performance.now();
				sStats.loaded = arrBuf.byteLength;
				sStats.total = arrBuf.byteLength;

				callbacks.onSuccess(sResponse, sStats, context);
			}
			//console.log(arrBuf);
		});

    }

    /* abort any loading in progress */
    this.abort = function() {}
    /* destroy loading context */
    this.destroy = function() {}
  }

  function cacheFragment(url) {



  }

  var playlistLoader = function() {

  /* calling load() will start retrieving content at given URL (HTTP GET)

  See: https://github.com/dailymotion/hls.js/blob/master/API.md
  */


  this.load = function(context,config,callbacks) {
	console.log("playlistLoader.load called");
	//console.log(context);
	var url = context.url;
	var fname = url.split('/').pop();
	var sStats = {
		trequest: performance.now(),
		tfirst: performance.now()
	};
	//console.log([url, fname]);
	//console.log(callbacks);
	if(fname === "local.m3u8") {

		localPlaylist(function(m3u8) {
			var sResponse = {
				url: url,
				data: m3u8
			}
			sStats.tload = performance.now();
			sStats.loaded = m3u8.length; // assume no utf-8 characters
			sStats.total = m3u8.length;
			//console.log([sResponse, sStats, context]);
			callbacks.onSuccess(sResponse, sStats, context);
		}, currentplaylist);
	}

	else {
		var xhr = new XMLHttpRequest();
		xhr.open('GET', url, true);
		//xhr.responseType = responsetype;
		xhr.onreadystatechange = function () {
			if (xhr.readyState == 2) {
				stats.tfirst = performance.now();
			}
			else if (xhr.readyState == 4) {
				tracksegments(xhr.responseText);
				sStats.tload = performance.now();
				sStats.loaded = xhr.responseText.length; // assume no utf-8 characters
				sStats.total = xhr.responseText.length;
				callbacks.onSuccess(xhr.responseText, sStats, context);
			}
		};
		xhr.send(null);
	}
  }


  /* abort any loading in progress */
  this.abort = function() { console.log('pLoader abort called'); }
  /* destroy loading context */
  this.destroy = function() { console.log('pLoader abort called'); }
  }


  function refreshsegments() {
	//  return true;
	var xhr = new XMLHttpRequest();
	xhr.open('GET', playlist_url, true);
	//xhr.responseType = responsetype;
	xhr.onreadystatechange = function () {
		if (xhr.readyState == 4) {
			if(xhr.status == 200) tracksegments(xhr.responseText);
			else if(xhr.status == 404) set_broadcast_status('notbroadcasting');
			else set_broadcast_status('offline');

			refreshTimeout = window.setTimeout(refreshsegments, 5000);
		}
	};
	xhr.send(null);
  }

  function set_broadcast_status(status) {
		if(status === "broadcasting") {
			$("#broadcast-status").addClass("broadcasting").removeClass("notbroadcasting").removeClass("notavailable");
		}
		else if(status === "notbroadcasting") {
			$("#broadcast-status").addClass("notbroadcasting").removeClass("broadcasting").removeClass("notavailable");
		}
		else if(status === "notavailable") {
			$("#broadcast-status").addClass("notavailable").removeClass("notbroadcasting").removeClass("broadcasting");
		}

		else if(status === "offline") {
			$("#broadcast-status").addClass("offline").removeClass("notbroadcasting").removeClass("notavailable");
		}

		else if(status === "recording") {
			$("#broadcast-status").addClass("recording");
		}
		else if(status === "notrecording") {
			$("#broadcast-status").removeClass("notrecording");
		}

		var txt = '';
		if($("#broadcast-status").hasClass("broadcasting")) txt = "Broadcasting";
		else if($("#broadcast-status").hasClass("notavailable")) txt = "Not Available";
		else if($("#broadcast-status").hasClass("notbroadcasting")) txt = "Not Broadcasting";
		else if($("#broadcast-status").hasClass("offline")) txt = "Offline";
		else txt = status;

		if($("#broadcast-status").hasClass("recording")) txt += ", Recording";

		$("#broadcast-status .txt").text(txt);

		callStatusWindow('setBroadcastStatus', $("#broadcast-status .txt").text(), $("#broadcast-status").attr('class'));
  }

  function tracksegments(m3u8) {
		var last = 0; // timestamp of last segment processed... whether from cache or server
		var lastDuration = 0;
		var first = 0; // timestamp of first segment in this file
		var currentTime = new Date().getTime();

		if(!parsed_m3u8) {
			console.log('creating new map from tracksegments');
			parsed_m3u8 = new Map();
		}
		else last = m3u8_last_ts;

		var len = m3u8.length;
		if(len > 20) {
			var newsig = m3u8.substr(len-20);
			if(newsig == m3u8_signature) {
				// m3u8 not changed, get last segment time... is it old?
				console.log('m3u8 not changed');
				var offset = currentTime - m3u8_last_update;
				if(offset > 20*1000) set_broadcast_status("notbroadcasting");
				return true;
			}
			else {
				m3u8_signature = newsig;
				console.log('m3u8 changed');
			}
		}

		var regexp = /(?:#EXT-X-(MEDIA-SEQUENCE):(\d+))|(?:#EXT-X-(TARGETDURATION):(\d+))|(?:#EXT-X-(KEY):(.*))|(?:#EXT(INF):([\d\.]+)[^\r\n]*([\r\n]+[^#|\r\n]+)?)|(?:#EXT-X-(BYTERANGE):([\d]+[@[\d]*)]*[\r\n]+([^#|\r\n]+)?|(?:#EXT-X-(ENDLIST))|(?:#EXT-X-(DIS)CONTINUITY))|(?:#EXT-X-(PROGRAM-DATE-TIME):(.*))/g;
		while ((result = regexp.exec(m3u8)) !== null) {
			result.shift();
			result = result.filter(function(n) { return (n !== undefined); });
			if(result[0] === "INF") {
				var seg = result[2].substring(1, result[2].length-3);
				var segint = parseInt(seg,10);

				// make sure we don't add any older entries due to
				// server holding longer than expected max age
				// or clock differential between client and server
				if( ((currentTime - segint) > MAX_AGE_LOCAL) || (segint <= last)) continue;

				if(!parsed_m3u8.has(segint)) {
					// automatically add discontinuity if we have a new segment more than 30s after the last one.
					// prevents problems when we start up with previously cached data, but the server doesn't have any of our cached data
					if(last > 0 && lastDuration !== "DIS" && ((segint - last) > 30000)) {
						console.log(["added discontinuity, more than 30s hole", segint, result[1]]);
						parsed_m3u8.set(segint-1, "DIS");
						add_segment_block(segint-1, "DIS");
					}

					$("#dE-"+seg+" td:last-of-type").text(result[1]);
					parsed_m3u8.set(segint, result[1]);
					add_segment_block(segint, result[1]);

					// segment is within recording time... cache it
					if(shouldRecordSegment(seg)) {
						getMulti(remote_path + seg + '.ts');
					}
				}
				last = segint;
				lastDuration = result[1];
				if(first === 0) {
					//console.log(last
					first = last;
				}
			}
			else if(first > 0 && result[0] === "DIS") {
				// discontinuity shows in array as the last ordered segment time + 1ms
				//console.log(["discontinuity in source playlist", last]);
				var seg = last+1;
				lastDuration = "DIS";

				if(!parsed_m3u8.has(seg)) {
					console.log(["added discontinuity from playlist", seg]);
					parsed_m3u8.set(seg, "DIS");
					add_segment_block(seg, "DIS");
				}
			}

			//console.log(result);
		}
		if(segint) m3u8_last_ts = segint;

		// set broadcast status on second load... that way we see if the playlist has changed
		if(m3u8_last_update > 0) set_broadcast_status("broadcasting");

		m3u8_last_update = currentTime;
		var contentBlob = new Blob([JSON.stringify(Array.from(parsed_m3u8.entries()))], {type: 'application/json'});
		saveFile("segments.json", contentBlob, false);
  }

  function tsClick() {

	var timestamp = parseInt($(this).attr('id').split('-').pop(),10);
	if($(this).hasClass('dis')) { alert('Not a segment'); return false; }

	get_seek_time(timestamp,true);

	/*
	if($(this).hasClass('cached')) { alert('Already loaded'); return false; }
	if($(this).hasClass('dis')) { alert('Not a segment'); return false; }

	var currentTime = new Date().getTime();
	if((currentTime - timestamp) > MAX_AGE_SERVER) { alert('Segment too old'); return false; }

	startRecord(timestamp, 60);
	*/
  }

  function recordFromPlayer() {
	var frag = $("#ts_segments span.playing:first");
	var timestamp = parseInt(frag.attr('id').split('-').pop(),10);

	var currentTime = new Date().getTime();
	if((currentTime - timestamp) > MAX_AGE_SERVER) { alert('Segment too old'); return false; }

	startRecord(timestamp, parseInt($("#recordtime").val(),10)*1000);
  }

  function startRecord(timestamp, duration) {
	var segs = [];
	var segduration = 0;
	cacheEnd = timestamp + duration;

	// don't try to fetch anything that is likely to be deleted... 30 second margin
	var oldest_possible = new Date().getTime() + 30000 - MAX_AGE_SERVER;

	for (var ts of parsed_m3u8.keys()) {
		if(ts < timestamp) continue;
		if(ts < oldest_possible) continue;
		if(cached[ts]) continue;

		if(ts > cacheEnd) break;
		//if(segduration > duration) break;

		segs.push(remote_path + ts + '.ts');
		segduration += parseFloat(parsed_m3u8.get(ts));
	}

	if(segs.length) {
		console.log(segs);
		getMulti(segs);
	}

	return segs.length;

  }

  function add_segment_block(ts, duration, cached) {
	//if(typeof cached !== 'undefined') console.log(['add_segment_block',ts, duration, cached]);
	var ele = $("#tsCache-"+ts);
	if(ele.length < 1) {
		var title = new Date(ts).toLocaleString();
		var classes = [];
		if(duration === "DIS") classes.push('dis');
		else {
			addSegmentToRecording(ts, parseFloat(duration));
		}
		if(cached) classes.push('cached');

		var seg_html = "<span title=\""+title+"\" id=\"tsCache-"+ts+"\"" + (classes.length ? 'class="'+classes.join(' ') +'" ': '') + "/>";
		$("#ts_segments").append($(seg_html).click(tsClick));

		callStatusWindow('appendTsSeg', seg_html);
	}
  }
  // assume all tracked segments are available either on server or locally cached
  function localPlaylist(callback, recording_ts) {
	//console.log(["localPlaylist called", recording_ts]);

	// parsed_m3u8 is an ES6 map... key is integer timecode, val is string duration or "DIS"
	var playlist = "#EXTM3U\n#EXT-X-PLAYLIST-TYPE:LIVE\n#EXT-X-TARGETDURATION:4\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:"+m3u8_media_sequence+"\n";
	var last = '';
	var lastts = new Date().getTime();

	var total = 0;
	for(var [ts, duration] of parsed_m3u8.entries()) {
		if(recording_ts && ts < recording_ts) continue;
		if(recording_ts && ts > lastts + (300*1000)) {
			playlist += "#EXT-X-ENDLIST\n";
			break;
		}

		if(duration === "DIS") {
			playlist += "#EXT-X-DISCONTINUITY\n";
		}

		else {
			playlist += "#EXTINF:"+duration+",\n"+ts+".ts\n";
			lastts = ts;
			total += parseFloat(duration);
		}

		last = duration;
	}
	/*
	try
	{
		console.log(['total playlist duration', total, $('video').get(0).duration]);
	}
	catch (err)
	{
		console.log(err);
	}
	*/
	callback(playlist);
  }


  function first_seg_time() {
		var starttime = false;
		// get time of first segment in playlist
		for (var ts of parsed_m3u8.keys())
		{
			if(ts > 1000000000000) {
				starttime = ts;
				break;
			}
		}
		return starttime;
  }

  function get_broadcast_time() {
	var starttime = first_seg_time()
	if(!starttime) return false;

	var video = document.getElementById("video");
	var vidtime = video.currentTime;
	return starttime + vidtime;
  }

  function seekPct(pct) {
	  video.currentTime = video.duration*(pct/100);
  }

  function get_seek_time(input_time, use_sub_playlist) {
	var prev = false;
	var offset = 0;

	//input_time = "2016-04-11 16:45";
	if(typeof input_time === "number") {
		broadcast_time = input_time;
	}
	else {
		input_time = input_time.replace("T", " ");
		broadcast_time = new Date(input_time).getTime();
	}

	if(use_sub_playlist) {
		console.log("use_sub_playlist = true");
		currentplaylist = getRecording(input_time);
	}

	else currentplaylist = 0;

	// add up all segment durations until we reach the expected timestamp
	for (var [ts, duration] of parsed_m3u8.entries())
	{
		if(ts > 1000000000000) {
			if(ts > broadcast_time) {
				//console.log([input_time, broadcast_time, ts]);
				break;
			}
			if( ts > currentplaylist) {
				if(duration != "DIS") offset += parseFloat(duration);
				prev = ts;
			}
		}
	}

	if(prev === false) {
		console.log("NO BROADCAST AT SPECIFIED TIME (BEFORE FIRST SEGMENT)");
		return false;
	}
	else if(duration === "DIS") {
		console.log("NO BROADCAST AT SPECIFIED TIME (DISCONTINUITY)");
		return false;
	}
	else if(ts < broadcast_time) {
		console.log("NO BROADCAST AT SPECIFIED TIME (REACHED END OF BROADCAST)");
		return false;
	}

	else {
		console.log("FOUND BROADCAST TIME!");
		offset += (m3u8_target_duration*(m3u8_media_sequence-1));

		var seektime = (broadcast_time - ts)/1000 + offset;
		console.log([broadcast_time, prev, offset, seektime]);
		var video = $("#video").get(0);

		if(hls && currentplaylist === false) {
			video.currentTime = seektime;
			video.play();
			return broadcast_time - prev + offset;
		}
		else {
			error_workaround_time = offset;
			console.log("setting initial seek to: " + offset);
			markActiveRecording(currentplaylist);
			if(hls === false) loadplayer();
			else hls.detachMedia();
		}

		//$("#video").get(0).play();
	}
  }

	function init_broadcast_time() {
		var currentDate = new Date();
		var timezoneOffset = currentDate.getTimezoneOffset() * 60 * 1000;
		var localDate = new Date(currentDate.getTime() - timezoneOffset);
		var localDateISOString = localDate.toISOString().replace('Z', '');
		$("#seek_to_broadcast_time").val(localDateISOString);
	}

	function loadplayer() {
		init_broadcast_time();
		console.log([!parsed_m3u8, parsed_m3u8.size]);
		if(!parsed_m3u8 || parsed_m3u8.size < 1) {
			window.setTimeout(loadplayer, 500);
			return false;
		}
		//$("#seek_to_broadcast_time
		  if(Hls.isSupported()) {
			var video = document.getElementById('video');
			$(video).on("play", function() {
				callStatusWindow('setPlayPause', "play");
			});

			$(video).on("pause", function() {
				callStatusWindow('setPlayPause', "play");
			});

			hls = new Hls({
				defaultAudioCodec: 'mp4a.40.2',
				fLoader: fragmentLoader,
				pLoader: playlistLoader,
				maxBufferLength : 30,
				maxBufferHole: 0.5,
				maxSeekHole: 15,
				debug: function(log, msg) { console.log([log,msg]) }
			});
			// bind them together
			hls.attachMedia(video);
			$("body").off("keyup").on("keyup", keyup);

			hls.on(Hls.Events.MEDIA_ATTACHED,function() {
				console.log("video and hls.js are now bound together !");
				//hls.loadSource("http://clientname.dvp.lightcastmedia.com/dvp/clientname/local.m3u8");
				hls.loadSource(playlist_url.replace("index.m3u8", "local.m3u8"));
			 });
				hls.on(Hls.Events.MANIFEST_PARSED, function(event,data) {
				 console.log("manifest loaded, found " + data.levels.length + " quality level");
				 if(error_workaround_time) {
					 console.log(["error recovery", error_workaround_time]);
					video.currentTime = error_workaround_time;
					error_workaround_time = 0;
				 }
				 video.play();
				})
			hls.on(Hls.Events.MEDIA_DETACHED,function() {
				console.log(["MEDIA DETACHED", error_workaround_time]);
				//if(error_workaround_time) window.setTimeout(loadplayer, 50);
				window.setTimeout(loadplayer, 50);
			});
			hls.on(Hls.Events.ERROR,function(event, data) {
				var errorType = data.type;
				var errorDetails = data.details;
				var errorFatal = data.fatal;
				console.log(["ERROR", errorType, errorDetails, errorFatal]);
				if(errorDetails == "bufferSeekOverHole") {
					//error_workaround_time = video.currentTime + 0.5;
					//hls.detachMedia();
				}
				if(errorDetails == "fragLoopLoadingError") {
					error_workaround_time = video.currentTime + 10;
					hls.detachMedia();
				}
				if(errorDetails == "bufferStalledError") {
					if(video.currentTime + 10 < video.duration) {
						console.log(['BEGIN ERROR RECOVERY', video.currentTime]);
						//error_workaround_time = video.currentTime + 10;
						//hls.detachMedia();
					}
					else console.log("bufferStalledError at end of video");
				}
			});
		 }
	}

function saveConfiguration() {
	var obj = {
		'domain': $('#config-domain').val(),
		'quota': parseInt($('#config-quota').val(),10)*1024*1024, // stored in bytes
		'server_max_age': parseInt($('#config-server-max-age').val(),10)*60*1000, // form in minutes, stored in ms
		'local_max_age': parseInt($('#config-local-max-age').val(),10)*24*60*60*1000, // form in days, stored in ms
	};

	localStorage.setItem('offline-config', JSON.stringify(obj));

	navigator.webkitPersistentStorage.requestQuota(obj.quota, function(grantedSize) {
		console.log([obj.quota, grantedSize]);
		if(grantedSize >= obj.quota) location.reload();
		else {
			alert("PERMISSION DENIED: Failed to get requested storage");
		}
	});

}

function formatBytes(bytes,decimals) {
   if(bytes == 0) return '0 Byte';
   var k = 1024; // or 1024 for binary
   var dm = decimals + 1 || 3;
   var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
   var i = Math.floor(Math.log(bytes) / Math.log(k));
   return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function trackWindow() {
	$("#statusWindowButton").addClass("selected");
    if ((statusWindow != null) && (statusWindow.closed == false)) {
		statusWindow.focus();
		return;
    }

    var windowUrl = 'statuswindow.html';
    var windowId = 'statusWindow';
    var windowFeatures = 'channelmode=no,directories=no,fullscreen=no,' + 'location=no,dependent=yes,menubar=no,resizable=yes,scrollbars=yes,' + 'status=no,toolbar=no,titlebar=no,' + 'left=0,top=0,width=1000px,height=700px';

    statusWindow = window.open(windowUrl, windowId, windowFeatures);
	window.setTimeout(setInitialStatusWindow, 500);

    statusWindow.focus();
}

function captureImage(height) {
		if(statusWindow) {
			var video = $("video").get(0);
			var canvas = document.createElement("canvas");
			var scale = height / video.videoHeight;
			canvas.width = video.videoWidth * scale;
			canvas.height = video.videoHeight * scale;
			canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
			console.log("canvas data url is " + canvas.toDataURL().length);

			return canvas.toDataURL();
		}
}


function listRecordings() {
	var max_discontinuity = 300*1000; // consider a separate recording if 5 minutes between segments

	// we can get away with a simple object and sort the keys each time we use it, since this should never be too long
	// default sort works because the value will always be digits and always the same string length
	//recordings = {};
	var current_recording = 0;
	var last_seg = 0;
	for (var [ts, duration] of parsed_m3u8.entries()) {
		if(duration === "DIS") continue;
		if(ts > last_seg + max_discontinuity) {
			recordings[ts] = current_recording = last_seg = ts;
			continue;
		}

		recordings[current_recording] = last_seg = ts;

	}
	return recordings;
	console.log(recordings);
}

function formatDuration(msec) {
	var duration = new Date(msec);
	var durationfmt = pad(duration.getUTCHours()) + ':' + pad(duration.getUTCMinutes()) + ':' + pad(duration.getUTCSeconds()); // + " | " + duration.toISOString();
	return durationfmt;
}

function pad(str,len,padchr,direction) {
	if(typeof str === "number") str = str + "";
	if(!len) len = 2;
	if(!padchr) padchr = "0";
	if(!direction) direction = "left";
	//console.log([str, len, padchr, direction]);

	while(str.length < len) {
		if(direction === "left") str = padchr + str;
		else str += padchr;
	}
	return str;
}

function getRecording(seekts) {
	var tsint = 0;
	var seekts = parseFloat(seekts);

	var keys = Object.keys(recordings).sort();
	for(var i = 0; i < keys.length; i++) {
		tsint = parseInt(keys[i],10);
		var lastDuration =  parseFloat(parsed_m3u8.get(recordings[tsint]))*1000;
		var lastTs = recordings[tsint] + lastDuration;

		if(lastTs > seekts) {
			return tsint;
		}
	}
	return false;
}

function showRecordings(recordings) {
	var tsint = 0;

	var keys = Object.keys(recordings).sort();
	for(var i = 0; i < keys.length; i++) {
		tsint = parseInt(keys[i],10);
		var lastDuration =  parseFloat(parsed_m3u8.get(recordings[tsint]))*1000;
		var recordDuration = recordings[tsint] + lastDuration - tsint;
		showRecording(tsint, recordDuration);
	}
}

function showRecording(tsint, duration) {
	var id = "recording-" + tsint;
	if($("#"+id).length) return;

	var day = new Date(tsint);
	var hours = day.getHours();
	var meridiem = "AM";
	if(hours > 12) {
		hours -= 12;
		meridiem = "PM";
	}
	var datefmt = days[day.getDay()] + ' ' + pad(day.getMonth()+1) + '/' + pad(day.getDate()) + ' ' + pad(hours) + ':' + pad(day.getMinutes()) + " " + meridiem;
	var durationfmt = formatDuration(duration);

	$("#recordings tbody").append(
		//"<tr id=\"" + id + "\"><td>" + datefmt + "&nbsp;</td><td>" + durationfmt + "</td><td><button onclick=\"playRecording("+tsint+");\">Play</button><button>Delete</button></td></tr>"
		"<tr id=\"" + id + "\"><td>" + datefmt + "&nbsp;</td><td>" + durationfmt + "</td><td><button onclick=\"playRecording("+tsint+");\">Play</button><button>Delete</button><button onclick=\"downloadRecording("+tsint+");\">Save</button></td></tr>"
	);
	// <button>Archive</button>
}

function clearPlaying() {
	var ele = $("#recordings tr.playing").removeClass("playing");
	ele.find("button").prop('disabled', false);
	ele.find("td button:first-of-type").text("Play");
}

function markActiveRecording(playListTS) {
	clearPlaying();

	var ele = $("#recording-" + playListTS).addClass("playing")
	ele.find("button").prop('disabled', true);
	ele.find("td button:first-of-type").text("Playing");

	callStatusWindow('setRecordings', $("#recordingsholder").html());
}

function playRecording(playListTS) {
	currentplaylist = playListTS;
	error_workaround_time = 0;

	// reset media sequence
	m3u8_media_sequence = m3u8_media_offset = 0;

	markActiveRecording(playListTS);

	// restart player
	if(hls === false) loadplayer();
	else hls.detachMedia();
}

function addSchedule() {
	var hour = parseInt($("#schedule_hour").val());
	if(!hour) hour = 0;
	if($("#schedule_meridiem").val() == "PM" && hour < 12) hour += 12;
	else if($("#schedule_meridiem").val() == "AM" && hour == "12") hour = 0; // 12 hour clock... 12:01am == 00:01 in 24 hour clock

	var min = parseInt($("#schedule_min").val());
	if(!min || min > 59) min = 0;

	var duration = parseInt($("#schedule_duration").val(),10);
	if(!duration || duration > 999) duration = 30;

	// store schedule as a fixed length string so it is easier to sort.
	var str = $("#schedule_dow").val() + pad(hour) + pad(min) + pad(duration, 3);

	schedule.push(str);
	schedule.sort();
	updateSchedule();
}

function updateSchedule() {
	$("#schedule tr:not(#schedule_input)").remove();
	var out = "";
	for(var i = 0; i < schedule.length; i++) {
		var str = schedule[i];
		var hour = parseInt(str.slice(1,3),10);
		var min = str.slice(3,5);

		var meridiem = "AM";
		if(hour === 0) hour = 12;
		else if(hour > 12) { meridiem = "PM"; hour -= 12; }

		out = "<tr><td>" + days[str[0]] + "</td>";
		out += "<td>" + hour + ':' + min + ' ' + meridiem + "</td>";
		out += "<td>" + str.slice(-2) + " min</td>";
		out += '<td><button onclick="delSchedule('+str+')">Delete</button></td>';
		out += "</tr>";

		//$("#schedule tbody").append(out);
		$("#schedule_input").before(out);
	}
}

function shouldRecordSegment(ts) {
	// called when a new segment is added to the server playlist
	if(cacheEnd && ts < cacheEnd) return true;

	// schedule is in order by startts
	for(var i = 0; i < recordQueue.length; i++) {
		// sanity check, in case shouldRecordSegment is called in between updates of checkSchedule
		if (ts > recordQueue[1]) continue;
		else if (ts > recordQueue[0]) return true;
	}

	return false;
}

function checkSchedule() {
	/*
		called on load
		called on schedule update
		called when switching from offline to online
		called when completing another schedule

		if offline, return
		if schedule is not set and player has requested a uncached segment in the last 15 seconds, return

		if recordings list is empty or changed
			create arary of recording ranges in reverse order
			merge overlapping ranges

		check recording list, update for next week any entries that have already cleared (end time is greater than now() - MAX_AGE_SERVER

		if player has requested a uncached segment in the last 15 seconds, return

		global variable to cancel promise downloads
		if downloadfilepromise sees this set, call reject... this should almost immediately reject everything in the chain as each promise function is called

		if player requests a segment that is not cached, set variable, cancel all promise downloads




	*/

	var now = new Date();
	var now_ts = now.getTime();
	var now_dow = now.getDay();
	var now_day = now.getDate();

	if(!navigator.onLine || $("#broadcast-status").hasClass("offline")) return;
	if(now - lastUncachedSegment < 15000) return;

	var str = "";
	var dow = 0; var hour = 0; var min = 0; var duration = 0;

	// schedule entry format: DHHMMTT
	// D = Day of Week starting with 0 = Sun, HH = 24 hour clock, MM = minutes, TT = duration
	// month is zero-indexed (0-11)
	// var d = new Date(year, month, day, hours, minutes, seconds, milliseconds);
	// JS date objects accept day in the future and calculates correctly  (e.g. Dec 34 = Jan 3);

	var tmpq = [];
	for(var i = 0; i < schedule.length; i++) {
		str = schedule[i];
		dow = parseInt(str[0],10);
		hour = parseInt(str.slice(1,3),10);
		min = parseInt(str.slice(3,5),10);
		duration = parseInt(str.slice(-2),10);

		var day = now_day + (dow - now_dow);

		for(var i2 = 0; i2 < 2; i2++) {
			var start = new Date(now.getFullYear(), now.getMonth(), day, hour, min);
			var starttime = start.getTime();
			var endtime = starttime + (duration*60*1000);
			if(endtime > now - MAX_AGE_SERVER) break; // still possible to record
			day += 7;
		}

		tmpq.push([starttime, endtime]);

		console.log([new Date(starttime).toLocaleString(), new Date(endtime).toLocaleString()]);
	}

	// SORT, earliest first
	tmpq.sort(function(a,b) { return a[0] - b[0]});

	// MERGE OVERLAPPING
	recordQueue = [tmpq[0]];
	for(var i = 1; i < tmpq.length; i++) {
		// start of next segment is within previous segment... extend previous segment
		// use max to make sure we don't actually reduce the length (i.e. a segment that starts later, but is shorter)
		if(tmpq[i][0] <= recordQueue[recordQueue.length-1][1]) {
			console.log("found overlap");
			recordQueue[recordQueue.length-1][1] = Math.max(tmpq[i][1], recordQueue[recordQueue.length-1][1]);
		}
		else recordQueue.push(tmpq[i]);
	}

	// DEBUG RESULTS
	console.log(recordQueue);
	for(var i = 0; i < recordQueue.length; i++) {
		console.log([new Date(recordQueue[i][0]).toLocaleString(), new Date(recordQueue[i][1]).toLocaleString()]);
	}

	// START NEWEST SCHEDULE THAT EXISTS ON THE SERVER
	for(var i = recordQueue.length-1; i >= 0; i--) {
		// recording is in the future... any existing recording
		if(recordQueue[0] > now_ts) continue;
		if(recordQueue[1] < now_ts) break;
		startRecord(recordQueue[0], recordQueue[1] - recordQueue[0].duration);
		break;
	}

}


function delSchedule(str) {
	schedule.splice(schedule.indexOf(str));
	schedule.sort();
	updateSchedule();
}

function exportRecording(ts) {
	// concatenate every segment we have starting with the time (ts) and ending with the first position we are missing at least 5 minutes
	// mpeg transport streams have no global headers, so they can be concatenated
	// fileEntry.toURL(opt_mimeType);
	// create a tag and simulate link
	// http://jsfiddle.net/koldev/cw7w5/
	// use settimeout to delete after adequate delay.
	// output file should work in VLC, Media Player Classic, avidemux and possibly others
}


function setInitialStatusWindow() {
	if(statusWindow) {
		try
		{
			statusWindow.setBroadcastStatus($("#broadcast-status .txt").text(), $("#broadcast-status").attr('class'));
			statusWindow.setElement('ts_segments', $("#ts_segments").html());
			statusWindow.setRecordings($("#recordingsholder").html());
		}
		catch (err)	{ }
	}
}

function menubarToggle(evt) {
	console.log(evt);
	console.log(this);
	var txt = $(this).text();
	var ele = false;
	var display = "block";

	if(txt === "Status Window") {
		return;
	}


	if(txt === "Storage") { ele = "#segmentholder"; display = "inline-block"; }
	if(txt === "Recordings") ele = "#recordingsholder";
	if(txt === "Schedule") ele = "#scheduleholder";

	var active = $(this).hasClass("selected");

	if(active) $(this).removeClass("selected");
	else $(this).addClass("selected");

	if(ele) {
		if(active) $(ele).hide();
		else $(ele).css("display", display);
	}

	if(txt === "Status Window") ele = "#segmentholder";

}

function isEmptyObject(map) {
   for(var key in map) {
      if (map.hasOwnProperty(key)) {
         return false;
      }
   }
   return true;
}
