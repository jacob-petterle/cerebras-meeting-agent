#include "MeetingShareCtrlEvent.h"

#include "../util/Log.h"

namespace {
    string describeSharingStatus(SharingStatus status) {
        switch (status) {
            case Sharing_Self_Send_Begin:            return "Sharing_Self_Send_Begin";
            case Sharing_Self_Send_End:              return "Sharing_Self_Send_End";
            case Sharing_Self_Send_Pure_Audio_Begin: return "Sharing_Self_Send_Pure_Audio_Begin";
            case Sharing_Self_Send_Pure_Audio_End:   return "Sharing_Self_Send_Pure_Audio_End";
            case Sharing_Other_Share_Begin:          return "Sharing_Other_Share_Begin";
            case Sharing_Other_Share_End:            return "Sharing_Other_Share_End";
            case Sharing_Other_Share_Pure_Audio_Begin: return "Sharing_Other_Share_Pure_Audio_Begin";
            case Sharing_Other_Share_Pure_Audio_End:   return "Sharing_Other_Share_Pure_Audio_End";
            case Sharing_Pause:                      return "Sharing_Pause";
            case Sharing_Resume:                     return "Sharing_Resume";
            default:                                 return "SharingStatus(" + to_string(status) + ")";
        }
    }
}

void MeetingShareCtrlEvent::onSharingStatus(ZoomSDKSharingSourceInfo shareInfo) {
    auto msg = "share status: " + describeSharingStatus(shareInfo.status) +
               " (userid=" + to_string(shareInfo.userid) +
               ", shareSourceID=" + to_string(shareInfo.shareSourceID) + ")";

    // Our own share beginning is the green light that setExternalShareSource was
    // accepted; visibility for a participant is still verified manually.
    if (shareInfo.status == Sharing_Self_Send_Begin)
        Log::success(msg);
    else
        Log::info(msg);
}

void MeetingShareCtrlEvent::onFailedToStartShare() {
    Log::error("onFailedToStartShare: the SDK rejected the share start "
               "(check share policy / host privilege / existing active share)");
}
