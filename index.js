/* jshint node: true */
'use strict';

var EventEmitter = require('events').EventEmitter;
var rtc = require('rtc');
var debug = rtc.logger('rtc-quickconnect');
var signaller = require('rtc-signaller');
var defaults = require('cog/defaults');
var reTrailingSlash = /\/$/;

/**
  # rtc-quickconnect

  This is a high level helper module designed to help you get up
  an running with WebRTC really, really quickly.  By using this module you
  are trading off some flexibility, so if you need a more flexible
  configuration you should drill down into lower level components of the
  [rtc.io](http://www.rtc.io) suite.  In particular you should check out
  [rtc](https://github.com/rtc-io/rtc).

  ## Example Usage

  In the simplest case you simply call quickconnect with a single string
  argument which tells quickconnect which server to use for signaling:

  <<< examples/simple.js

  ## Example Usage (using data channels)

  When working with WebRTC data channels, you can call the `createDataChannel`
  function helper that is attached to the object returned from the
  `quickconnect` call.  The `createDataChannel` function signature matches
  the signature of the `RTCPeerConnection` `createDataChannel` function.

  At the minimum it requires a label for the channel, but you can also pass
  through a dictionary of options that can be used to fine tune the
  data channel behaviour.  For more information on these options, I'd
  recommend having a quick look at the WebRTC spec:

  http://dev.w3.org/2011/webrtc/editor/webrtc.html#dictionary-rtcdatachannelinit-members

  If in doubt, I'd recommend not passing through options.

  <<< examples/datachannel.js

  __NOTE:__ Data channel interoperability has been tested between Chrome 32
  and Firefox 26, which both make use of SCTP data channels.

  __NOTE:__ The current stable version of Chrome is 31, so interoperability
  with Firefox right now will be hard to achieve.

  ## Example Usage (using captured media)

  Another example is displayed below, and this example demonstrates how
  to use `rtc-quickconnect` to create a simple video conferencing application:

  <<< examples/conference.js

  ## Regarding Signalling and a Signalling Server

  Signaling is an important part of setting up a WebRTC connection and for
  our examples we use our own test instance of the
  [rtc-switchboard](https://github.com/rtc-io/rtc-switchboard). For your
  testing and development you are more than welcome to use this also, but
  just be aware that we use this for our testing so it may go up and down
  a little.  If you need something more stable, why not consider deploying
  an instance of the switchboard yourself - it's pretty easy :)

  ## Reference

  ```
  quickconnect(signalhost, opts?) => rtc-sigaller instance (+ helpers)
  ```

  ### Valid Quick Connect Options

  The options provided to the `rtc-quickconnect` module function influence the
  behaviour of some of the underlying components used from the rtc.io suite.

  Listed below are some of the commonly used options:

  - `ns` (default: '')

    An optional namespace for your signalling room.  While quickconnect
    will generate a unique hash for the room, this can be made to be more
    unique by providing a namespace.  Using a namespace means two demos
    that have generated the same hash but use a different namespace will be
    in different rooms.

  - `room` (default: null) _added 0.6_

    Rather than use the internal hash generation
    (plus optional namespace) for room name generation, simply use this room
    name instead.  __NOTE:__ Use of the `room` option takes precendence over
    `ns`.

  - `debug` (default: false)

  Write rtc.io suite debug output to the browser console.

  #### Options for Peer Connection Creation

  Options that are passed onto the
  [rtc.createConnection](https://github.com/rtc-io/rtc#createconnectionopts-constraints)
  function:

  - `constraints`

    Used to provide specific constraints when creating a new
    peer connection.

  #### Options for P2P negotiation

  Under the hood, quickconnect uses the
  [rtc/couple](https://github.com/rtc-io/rtc#rtccouple) logic, and the options
  passed to quickconnect are also passed onto this function.

**/
module.exports = function(signalhost, opts) {
  var hash = location.hash.slice(1);
  var signaller = require('rtc-signaller')(signalhost);

  // init configurable vars
  var ns = (opts || {}).ns || '';
  var room = (opts || {}).room;
  var debugging = (opts || {}).debug;

  // collect the local streams
  var localStreams = [];

  // create the known data channels registry
  var channels = {};

  function gotPeerChannel(channel, pc, data) {
    // create the channelOpen function
    var emitChannelOpen = signaller.emit.bind(
      signaller,
      channel.label + ':open',
      channel,
      data.id,
      data,
      pc
    );

    debug('channel ' + channel.label + ' discovered for peer: ' + data.id, channel);
    if (channel.readyState === 'open') {
      return emitChannelOpen();
    }

    channel.onopen = emitChannelOpen;
  }

  // if the room is not defined, then generate the room name
  if (! room) {
    // if the hash is not assigned, then create a random hash value
    if (! hash) {
      hash = location.hash = '' + (Math.pow(2, 53) * Math.random());
    }

    room = ns + '#' + hash;
  }

  if (debugging) {
    rtc.logger.enable.apply(rtc.logger, Array.isArray(debug) ? debugging : ['*']);
  }

  signaller.on('peer:announce', function(data) {
    var pc;
    var monitor;

    // if the room is not a match, abort
    if (data.room !== room) {
      return;
    }

    // create a peer connection
    pc = rtc.createConnection(opts, (opts || {}).constraints);

    // add the local streams
    localStreams.forEach(function(stream) {
      pc.addStream(stream);
    });

    // add the data channels
    // do this differently based on whether the connection is a
    // master or a slave connection
    if (signaller.isMaster(data.id)) {
      debug('is master, creating data channels: ', Object.keys(channels));

      // create the channels
      Object.keys(channels).forEach(function(label) {
        gotPeerChannel(pc.createDataChannel(label, channels[label]), pc, data);
      });
    }
    else {
      pc.ondatachannel = function(evt) {
        // if the data channel is a known channel monitor it for open
        if (evt && evt.channel && channels[evt.channel.label] !== undefined) {
          gotPeerChannel(evt.channel, pc, data);
        }
      };
    }

    // couple the connections
    monitor = rtc.couple(pc, data.id, signaller, opts);

    // emit the peer event as per <= rtc-quickconnect@0.7
    signaller.emit('peer', pc, data.id, data, monitor);

    // once active, trigger the peer connect event
    monitor.once('active', function() {
      signaller.emit('peer:connect', pc, data.id, data);
    });

    // if we are the master connnection, create the offer
    // NOTE: this only really for the sake of politeness, as rtc couple
    // implementation handles the slave attempting to create an offer
    if (signaller.isMaster(data.id)) {
      monitor.createOffer();
    }
  });

  // announce ourselves to our new friend
  setTimeout(function() {
    signaller.announce({ room: room });
  }, 0);

  /**
    ### Quickconnect Broadcast and Data Channel Helper Functions

    The following are functions that are patched into the `rtc-signaller`
    instance that make working with and creating functional WebRTC applications
    a lot simpler.
    
  **/

  /**
    #### broadcast(stream)

    Add the stream to the set of local streams that we will broadcast
    to other peers.

  **/
  signaller.broadcast = function(stream) {
    localStreams.push(stream);
    return signaller;
  };

  /**
    #### createDataChannel(label, config)

    Request that a data channel with the specified `label` is created on
    the peer connection.  When the data channel is open and available, an
    event will be triggered using the label of the data channel.

    For example, if a new data channel was requested using the following
    call:

    ```js
    var qc = quickconnect('http://rtc.io/switchboard').createDataChannel('test');
    ```

    Then when the data channel is ready for use, a `test:open` event would
    be emitted by `qc`.

  **/
  signaller.createDataChannel = function(label, opts) {
    // save the data channel opts in the local channels dictionary
    channels[label] = opts || null;
    return signaller;
  };

  // pass the signaller on
  return signaller;
};