import { useState, useEffect, useContext } from "react";

import AuthContext from "../auth";

export default function ProfileModal({ closeCallback } : any) {
    const { auth } = useContext(AuthContext);

    const [newDN, setNewDN] = useState<string>("");
    const [newAM, setNewAM] = useState<string>("");
    const [avatarSrc, setAvatarSrc] = useState<string>("");

    const [currentPassword, setCurrentPassword] = useState<string>("");
    const [newPassword, setNewPassword] = useState<string>("");
    const [pwDisplay, setPWDisplay] = useState<string>("");

    const [err, setErr] = useState("");

    useEffect(() => {
        setAvatarSrc(import.meta.env.VITE_IMAGE_URL + "/" + auth.user.avatar);
    }, [auth.user.avatar]);

    const handleClose = () => {
        closeCallback();
    }

    const handleNewDNInput = (event: any) => {
        setNewDN(event.target.value);
    }

    const handleUpdateDN = async () => {
        let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/settings/update-profile", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({displayName: newDN})
                });
        if (res.ok) {
            setErr("");
            auth.user.displayName = newDN;
            setNewDN("");
        }
        else {
            setErr("Error");
        }
    }


    const handleNewAMInput = (event: any) => {
        setNewAM(event.target.value);
    }

    const handleUpdateAM = async () => {
        let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/settings/update-profile", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({away_msg: newAM})
                });
        if (res.ok) {
            setErr("");
            auth.user.away_msg = newAM;
            setNewAM("");
        }
        else {
            setErr("Error");
        }
    }

    const handleToggleAway = (_event: any) => {
        auth.setAway();
    }

    const [pendingAvatarFile, setPendingAvatarFile] = useState<File|null>(null);

    const handleChangeAvatar = (event: any) => {
        if (event.target.files && event.target.files[0]) {
            const file = event.target.files[0];
            setPendingAvatarFile(file);
            setAvatarSrc(URL.createObjectURL(file));
        }
    }

    const handleSaveAvatar = async () => {
        if (!pendingAvatarFile) return;
        let success = await auth.changeAvatar(pendingAvatarFile);
        if (success) {
            setPendingAvatarFile(null);
            setErr("");
        } else {
            setErr("Failed to upload avatar");
        }
    }

    const handleCurrentPWInput = (event: any) => {
        setCurrentPassword(event.target.value);
    }
    const handleNewPWInput = (event: any) => {
        setNewPassword(event.target.value);
    }
    const handleChangePW = async () => {
        let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/settings/set-password", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ currentPassword, newPassword })
                });
        if (res.ok) {
            setErr("");
            setNewDN("");

            // Visual indicator that request didnt fail
            let str = "";
            for (let i = 0; i < newPassword.length; i++) str += "*";
            setPWDisplay(str);
        }
        else {
            setErr("Error");
        }
    }

    return (
        <div className="modal-container">
            <div className="modal">
                <div style={{marginTop: "8px"}}>Id: {auth.user.id}</div>
                <div style={{marginTop: "8px"}}>Username: {auth.user.username}</div>
                <div style={{display: "flex", marginTop: "8px"}}>
                    <div>Display Name: {auth.user.displayName}</div>
                    <input style={{marginLeft: "8px"}} type="text" placeholder="New Display Name" onKeyUp={handleNewDNInput}/>
                    <button style={{marginTop: "auto"}} onClick={handleUpdateDN}>Update Display Name</button>
                </div>
                <div style={{display: "flex", marginTop: "8px"}}>
                    <div>Password: {pwDisplay}</div>
                    <input style={{marginLeft: "8px"}} type="password" placeholder="Current password" onKeyUp={handleCurrentPWInput}/>
                    <input style={{marginLeft: "8px"}} type="password" placeholder="New password" onKeyUp={handleNewPWInput}/>
                    <button style={{marginTop: "auto"}} onClick={handleChangePW}>Change Password</button>
                </div>
                <div style={{marginTop: "8px"}}>
                    <label>
                        <input type="checkbox" onChange={handleToggleAway} checked={auth.user.away}/> 
                        Set presence to away
                    </label>
                </div>
                <div style={{display: "flex", marginTop: "8px"}}>
                    <div>Away Message: {auth.user.away_msg}</div>
                    <input style={{marginLeft: "8px"}} type="text" placeholder="New Away Message" onKeyUp={handleNewAMInput}/>
                    <button style={{marginTop: "auto"}} onClick={handleUpdateAM}>Update Away Message</button>
                </div>
                <div style={{color: "red"}}>
                    { err }
                </div>
                <div style={{marginTop: "8px"}}>
                    <div>Avatar</div>
                    <div style={{display: "flex", alignItems: "center", gap: "8px", marginTop: "4px"}}>
                        <img
                            width="50px"
                            height="50px"
                            style={{objectFit: "cover", borderRadius: "4px", background: "#444"}}
                            src={avatarSrc}
                        />
                        <input type="file" accept="image/*" onChange={handleChangeAvatar}/>
                        {pendingAvatarFile && <button onClick={handleSaveAvatar}>Save Avatar</button>}
                    </div>
                </div>
                <button style={{marginTop: "16px"}} onClick={handleClose}>Close</button>
            </div>
        </div>
    )
}