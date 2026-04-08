import { createContext, useEffect, useState } from "react";

import { useNavigate } from "react-router-dom";

const AuthContext = createContext(null as any);

function AuthContextProvider(props: any) {
    const navigate = useNavigate();

    const [auth, setAuth] = useState({
        user: null,
        loggedIn: null
    }) as any;

    useEffect(() => {
        auth.getLoggedIn();
    }, []);

    auth.loginUser = async (username: string, password: string, oauth: boolean | undefined) => {
        try {
            let res;
            if (oauth) {
                res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/oauth-connect/existing", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({username, password})
                });
            }
            else {
                res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/login", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({username, password})
                });
            }

            if (res.ok) {
                setAuth((prevState: any) => ({...prevState, loggedIn: true}));
                await auth.getLoggedIn();
                navigate("/");
                return "";
            }
            else {
                return "Error";
            }
        }
        catch (err) {
            console.log(err);
            return "Error";
        }
    };

    auth.registerUser = async (username: string, password: string, oauth: boolean | undefined) => {
        try {
            let res;
            if (oauth) {
                res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/oauth-connect/new", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({username, password})
                });
            }
            else {
                res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/register", {
                    method: "POST",
                    credentials: "include",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({username, password})
                });
            }

            if (res.ok) {
               setAuth((prevState:any) => ({...prevState, loggedIn: true}));
                await auth.getLoggedIn();
                navigate("/");
                return "";
            }
            else {
                return "Error";
            }
        }
        catch (err) {
            console.log(err);
            return "Error";
        }
    };

    auth.getLoggedIn = async () => {
        try {
            let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/me", {
                credentials: "include"
            });

            if (res.ok) {
                let body = await res.json();
                setAuth((prevState: any) => ({
                    ...prevState,
                    user: { 
                        id: body.id, 
                        username: body.username, 
                        displayName: body.displayName, 
                        away: body.away, 
                        away_msg: body.away_msg,
                        avatar: body.avatar
                    },
                    loggedIn: true
                }));
            }
            else {
                setAuth((prevState: any) => ({
                    ...prevState,
                    user: null,
                    loggedIn: false
                }));
            }
        }
        catch (err) {
            console.log(err);
            setAuth((prevState: any) => ({
                ...prevState,
                user: null,
                loggedIn: false
            }));
        }
        
    };

    auth.logout = async () => {
        await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/logout", {
                method: "POST",
                credentials: "include"
            });
        setAuth((prevState: any) => ({
            ...prevState,
            user: null,
            loggedIn: false
        }));
    }

    auth.setAway = async (newAway:boolean|undefined, dontSendReq: boolean|undefined) => {
        if (newAway == undefined) newAway = !auth.user.away;
        let res;
        if (!dontSendReq) {
            res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/settings/update-profile", {
                method: "POST",
                credentials: "include",
                headers: { "content-type": "application/json" },
                    body: JSON.stringify({away: newAway})
            });
        }
        if (dontSendReq || res!.ok) {
            // Force re-render
            setAuth((prevState:any) => ({
                ...prevState,
                user: { ...prevState.user, away: newAway },
                loggedIn: prevState.loggedIn
            }));
        }
    }

    auth.changeAvatar = async (file: any) => {
        // Step 1: upload the file
        const formData = new FormData();
        formData.append("image", file);
        let uploadRes = await fetch(import.meta.env.VITE_BACKEND_URL + "/upload", {
            method: "POST",
            credentials: "include",
            body: formData
        });
        if (!uploadRes.ok) return false;
        const { url } = await uploadRes.json();

        // Step 2: save the URL to the user's profile
        let res = await fetch(import.meta.env.VITE_BACKEND_URL + "/auth/settings/avatar", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url })
        });
        if (res.ok) {
            setAuth((prevState:any) => ({
                ...prevState,
                user: { ...prevState.user, avatar: url },
                loggedIn: prevState.loggedIn
            }));
            return true;
        }
        return false;
    };
    
    return (
        <AuthContext.Provider value={{
            auth
        }}>
            {props.children}
        </AuthContext.Provider>
    );
}

export default AuthContext;
export { AuthContextProvider };