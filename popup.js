document.addEventListener('DOMContentLoaded', () => {
  const toggleButton = document.getElementById('toggleButton');

  // Check storage for the current state and set the button text
  chrome.storage.sync.get('scorerEnabled', ({ scorerEnabled }) => {
    toggleButton.textContent = scorerEnabled ? 'Disable' : 'Enable';
  });

  toggleButton.addEventListener('click', () => {
    chrome.storage.sync.get('scorerEnabled', ({ scorerEnabled }) => {
      const newState = !scorerEnabled;
      // Save the new state
      chrome.storage.sync.set({ scorerEnabled: newState });
      // Update the button text
      toggleButton.textContent = newState ? 'Disable' : 'Enable';

      // Send a message to the content script on the active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id) {
          // --- ADDED FOR DEBUGGING ---
          console.log(`[Popup] Sending 'toggle_ui' message. Enabled: ${newState}`);
          chrome.tabs.sendMessage(tabs[0].id, { action: 'toggle_ui', enabled: newState }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('[Popup] Error sending message:', chrome.runtime.lastError.message);
            } else {
              console.log('[Popup] Message received by content script.', response);
            }
          });
        } else {
          console.error("[Popup] Could not find an active tab to send a message to.");
        }
      });
    });
  });
});

