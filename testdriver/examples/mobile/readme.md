# Android Example

Starts a Genymotion cloud instance, downloads and installs an APK, Opens in browser.

This example only needs a Genymotion Key. It downloads a simple todo APK from a website
and installs.

The Recipe ID and APK URL will likely be env variables, but are hard coded here.

Also the starting and stopping of the android instance should be in a post and pre run
so the instance is always stopped whether the test passes or not.
