# Pomodoro System

Check for voice channel join on channels that have (focus/break Pomo) in the name.

Write a message in the adjacent text channel, and edit it until all users leave and the session is closed.

Message: "#Channel is in FOCUS! Good luck, BREAK starts <localtime/><spoiler>@user1 @user2</spoiler>"

Edit message based on current state of the session and what users are in the voice channel.

When switching stages, delete the message and recreate it so it will ping the users. Also the bot joins the voice channel, changes the name suffix to BREAK and then leaves again.

Also add a "Present" button to confirm that I'm still active.
Bot will respond with an ephemeral message that the present check was successful.

If I'm not present, kick me out of the voice channel after two stages of inactivity.

Maybe add image with fancy timer and who is present for how long.

Also don't count BREAKS into voice time.
