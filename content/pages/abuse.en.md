# Report abuse

Seen a name under sitey.my, sitey.one, officials.my or officials.one used for phishing, malware, spam or anything else in our [terms](/terms)? Tell us here. **No account is needed.**

We read every report, and a name that breaks the terms is taken down.

<form id="abuse-form" class="abuse-form" method="post" action="/api/abuse-reports" data-sent="Thank you — your report has been received. We will look at it." data-failed="The report could not be sent. Please try again in a moment." data-limited="Too many reports from here in a short time. Please try again later.">
<label for="abuse-target">Address</label>
<input id="abuse-target" name="target" type="text" required maxlength="512" placeholder="https://example.sitey.my" autocomplete="off">
<label for="abuse-reason">What is wrong with it</label>
<textarea id="abuse-reason" name="reason" required maxlength="4000" rows="6" placeholder="What it pretends to be, what it asks for, where you found the link…"></textarea>
<label for="abuse-contact">How to reach you <span class="abuse-optional">(optional)</span></label>
<input id="abuse-contact" name="contact" type="text" maxlength="255" placeholder="email or anything else" autocomplete="email">
<button type="submit" class="primary-button">Send report</button>
<p class="abuse-status" role="status" aria-live="polite"></p>
</form>

## Security issues in sitey itself

If you found a vulnerability in the service rather than a bad name, use the same form and say so. Our [security.txt](/.well-known/security.txt) points here as well.
